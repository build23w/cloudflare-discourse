import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  DISCOURSE: DurableObjectNamespace<Discourse>;
  DISCOURSE_HOSTNAME: string;
  DISCOURSE_ADMIN_EMAIL: string;
  DISCOURSE_ADMIN_USERNAME: string;
  CF_R2_ENDPOINT: string;
  CF_R2_UPLOADS_BUCKET: string;
  CF_R2_BACKUPS_BUCKET: string;
  CF_PLUGINS: string;
  // Space-separated plugin directory names to delete from the stock image at boot.
  // Fewer plugins means a much cheaper asset compile on small instance types.
  CF_REMOVE_PLUGINS?: string;
  // Rails request timeout in seconds; see the UNICORN_TIMEOUT note in the container.
  UNICORN_TIMEOUT?: string;
  // Web (pitchfork) worker count; the default of 3 fits standard-1.
  UNICORN_WORKERS?: string;
  // Import sanity floor for cf-migrate-seed: a restored dump that yields fewer
  // posts than this is treated as a failed seed rather than a valid forum.
  CF_SEED_POST_FLOOR?: string;
  DISCOURSE_SMTP_ADDRESS: string;
  DISCOURSE_SMTP_PORT: string;
  // secrets
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  DISCOURSE_ADMIN_PASSWORD?: string;
  DISCOURSE_SMTP_USER_NAME?: string;
  DISCOURSE_SMTP_PASSWORD?: string;
  // optional: `wrangler secret put CF_OPS_KEY` switches on the /_cf/ ops endpoints
  CF_OPS_KEY?: string;
  // optional: per-IP limiter (wrangler "unsafe" ratelimit binding) applied only to
  // requests that would consume container time — edge cache hits never touch it
  WAKE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // optional: extra R2 bucket for durable page snapshots that survive sleeps, deploys
  // and colo cache eviction. Everything works without it; you just lose the deepest
  // rescue tier while the container is waking.
  SNAPSHOTS?: R2Bucket;
}

// Stock discourse/base image + this entrypoint: pull the bootstrap bundle from R2
// (curl signs the request itself with sigv4) and hand off to cf-boot. The bundle is
// tried first because it is how `npm run update` ships boot-file changes without a
// redeploy — but on a fresh button-deploy the backups bucket is empty (and the R2
// secrets may not exist yet), so a missing/failed bundle falls back to the public
// repo tarball, whose container/files tree is byte-identical to what the bundle
// carries. Boot proceeds the same either way; the log line records which source won
// so a mis-provisioned R2 token is visible in the container logs.
const ENTRYPOINT_SCRIPT = [
  "set -e",
  "mkdir -p /cf",
  "src=",
  'if [ -n "$CF_R2_ACCESS_KEY_ID" ] && curl -fsSL --retry 5 --aws-sigv4 aws:amz:auto:s3 --user "$CF_R2_ACCESS_KEY_ID:$CF_R2_SECRET_ACCESS_KEY" "$CF_R2_ENDPOINT/$CF_R2_BACKUPS_BUCKET/bootstrap/bundle.tar.gz" -o /cf/bundle.tar.gz && tar xzf /cf/bundle.tar.gz -C /cf; then src=r2-bundle; fi',
  // The tarball nests everything under <repo>-<ref>/container/, so strip two levels
  // to land the same files/ tree the bundle produces.
  'if [ -z "$src" ]; then echo "[cf-entry] R2 bundle unavailable; fetching the repo tarball"; curl -fsSL --retry 5 "https://codeload.github.com/build23w/cloudflare-discourse/tar.gz/refs/heads/main" -o /cf/repo.tar.gz; tar xzf /cf/repo.tar.gz -C /cf --strip-components=2 --wildcards "*/container/files/*"; src=repo-tarball; fi',
  'echo "[cf-entry] bootstrap source: $src"',
  "exec bash /cf/files/usr/local/bin/cf-boot",
].join("; ");

export class Discourse extends Container<Env> {
  defaultPort = 80;
  // Idle time is not billed, so sleeping sooner is the main cost lever. The edge
  // cache re-serves every recently seen anonymous page while the container is out;
  // add the optional SNAPSHOTS bucket (a durable copy of every anonymous page ever
  // served) and even 30m sleeps stay invisible to visitors and crawlers.
  sleepAfter = "2h";
  entrypoint = ["/bin/bash", "-c", ENTRYPOINT_SCRIPT];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const smtpOn = Boolean(env.DISCOURSE_SMTP_PASSWORD);
    this.envVars = {
      // --- Discourse global settings (become discourse.conf at boot) ---
      DISCOURSE_HOSTNAME: env.DISCOURSE_HOSTNAME,
      DISCOURSE_DEVELOPER_EMAILS: env.DISCOURSE_ADMIN_EMAIL ?? "",
      RAILS_ENV: "production",
      // 3 web workers fit standard-1 (0.5 vCPU / 4 GiB) alongside postgres, redis
      // and sidekiq: when one worker is pinned by a slow on-demand asset compile,
      // the others keep serving. Set a UNICORN_WORKERS var when you raise
      // instance_type.
      UNICORN_WORKERS: env.UNICORN_WORKERS ?? "3",
      UNICORN_SIDEKIQS: "1",
      // Half a vCPU compiles on-demand assets (theme CSS, locale bundles) in tens of
      // seconds, and stock pitchfork kills those requests mid-compile — visible as
      // 500s with zero DB queries. Production hardcodes `timeout 30` (the
      // UNICORN_TIMEOUT env read is dev-only, so the var alone is a dead knob); the
      // container's unicorn run script seds that pitchfork.conf.rb line to this
      // value, pattern-guarded so it no-ops if upstream changes the line. A long
      // timeout turns the first hit after a cold boot from broken into merely slow;
      // the compile is disk-cached after that. Override with a UNICORN_TIMEOUT var.
      UNICORN_TIMEOUT: env.UNICORN_TIMEOUT ?? "180",
      DISCOURSE_DB_SOCKET: "/var/run/postgresql",
      // Cloudflare fronts the container: trust its forwarded client IP
      DISCOURSE_REAL_IP_HEADER: "CF-Connecting-IP",
      // Cloudflare fronts the container, so rate limiting must trust its edge ranges
      // or every visitor is attributed to a handful of CF IPs.
      DISCOURSE_TRUSTED_PROXIES:
        "127.0.0.1, 173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22, 141.101.64.0/18, 108.162.192.0/18, 190.93.240.0/20, 188.114.96.0/20, 197.234.240.0/22, 198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13, 104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22",
      // Master switch for cross-origin API reads (embedding latest.json widgets on
      // other sites); the allowed-origins list is the cors_origins site setting.
      DISCOURSE_ENABLE_CORS: "true",
      DISCOURSE_SKIP_EMAIL_SETUP: smtpOn ? "0" : "1",
      ...(smtpOn
        ? {
            DISCOURSE_SMTP_ADDRESS: env.DISCOURSE_SMTP_ADDRESS,
            DISCOURSE_SMTP_PORT: env.DISCOURSE_SMTP_PORT,
            DISCOURSE_SMTP_USER_NAME: env.DISCOURSE_SMTP_USER_NAME ?? "",
            DISCOURSE_SMTP_PASSWORD: env.DISCOURSE_SMTP_PASSWORD ?? "",
            // Port 465 is implicit TLS (Cloudflare Email Service); 587 is STARTTLS (SES etc.)
            ...(env.DISCOURSE_SMTP_PORT === "465"
              ? { DISCOURSE_SMTP_FORCE_TLS: "true", DISCOURSE_SMTP_ENABLE_START_TLS: "false" }
              : { DISCOURSE_SMTP_ENABLE_START_TLS: "true" }),
          }
        : {}),
      // --- our own plumbing (NOT DISCOURSE_*, so Discourse's S3 config stays in the DB
      //     and a migrated forum keeps its existing uploads bucket) ---
      CF_R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      CF_R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      CF_R2_ENDPOINT: env.CF_R2_ENDPOINT,
      CF_R2_UPLOADS_BUCKET: env.CF_R2_UPLOADS_BUCKET,
      CF_R2_BACKUPS_BUCKET: env.CF_R2_BACKUPS_BUCKET,
      CF_PLUGINS: env.CF_PLUGINS ?? "",
      CF_REMOVE_PLUGINS: env.CF_REMOVE_PLUGINS ?? "",
      // Forwarded only when set so cf-migrate-seed's own default (1000) stays the
      // single source of truth otherwise.
      ...(env.CF_SEED_POST_FLOOR ? { CF_SEED_POST_FLOOR: env.CF_SEED_POST_FLOOR } : {}),
      CF_ADMIN_EMAIL: env.DISCOURSE_ADMIN_EMAIL ?? "",
      CF_ADMIN_USERNAME: env.DISCOURSE_ADMIN_USERNAME ?? "admin",
      CF_ADMIN_PASSWORD: env.DISCOURSE_ADMIN_PASSWORD ?? "",
      CF_EMAILS_ENABLED: smtpOn ? "1" : "0",
    };
  }
}

const WAKING_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>Waking the forum…</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
  .card{text-align:center;max-width:28rem;padding:2rem}
  .spin{width:2.2rem;height:2.2rem;border:3px solid #444;border-top-color:#f60;border-radius:50%;margin:0 auto 1.2rem;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  p{color:#aaa;line-height:1.5}
</style></head>
<body><div class="card"><div class="spin"></div>
<h2>Forum is waking up</h2>
<p>Postgres, Redis and Rails are starting. A normal wake takes a few minutes; after a
Discourse update the first boot also rebuilds assets. This page refreshes itself.</p>
</div></body></html>`;

// Planted by the waking page AND by gate-path rescues; a browser carries it back on
// the next navigation, which is what authorizes a wake. Cookie-less curl loops never
// wake (or bill) anything.
const WAKE_COOKIE = "cf_wake=1; Path=/; Max-Age=600; SameSite=Lax; Secure";

function wakingResponse(setWakeCookie = false): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "retry-after": "15",
    "cache-control": "no-store",
  };
  // The waking page plants the short-lived cookie; its own auto-refresh carries it
  // back. Browsers pass this bar without noticing.
  if (setWakeCookie) headers["set-cookie"] = WAKE_COOKIE;
  return new Response(WAKING_PAGE, { status: 503, headers });
}

function wantsHtml(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

// A container whose R2 restore failed comes up as a brand-new, empty Discourse.
// Restarting it is the cure (the boot path re-imports from R2), and the post-count
// floor makes the endpoint safe to script into monitoring: against a populated forum
// it refuses to act, so it cannot be used to bounce a healthy site. Tune the floor to
// your forum's size — below it a restart is harmless anyway.
const HEALTHY_POST_FLOOR = 1000;

async function healIfBroken(container: DurableObjectStub<Discourse>): Promise<Response> {
  // State check first: containerFetch STARTS a sleeping container, so probing an
  // idle forum would wake it — and bill — on every monitoring call. Asleep means
  // there is nothing to heal; the next real visitor boots it on the normal path.
  const state = await container.getState().catch(() => null);
  const running = state !== null && /running|healthy|starting/i.test(JSON.stringify(state));
  if (!running) {
    return new Response("asleep — nothing to heal\n");
  }
  // Restart only on positive evidence of a failed restore: a 200 probe whose post
  // count parsed to a real number below the floor. Anything less certain — an error
  // page, an unparseable body — gets a refusal, because bouncing a healthy forum on
  // bad evidence is the worse failure mode.
  let posts: number;
  try {
    const res = await container.containerFetch("http://localhost/about.json");
    if (res.status !== 200) {
      return new Response(`probe returned ${res.status} — health unknown — refusing to restart\n`, { status: 409 });
    }
    const body = (await res.json().catch(() => null)) as
      | { about?: { stats?: { posts_count?: number } } }
      | null;
    const raw = body?.about?.stats?.posts_count;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return new Response("post count unknown — refusing to restart\n", { status: 409 });
    }
    posts = raw;
  } catch {
    return new Response("container unreachable; it is already restarting\n", { status: 503 });
  }
  if (posts >= HEALTHY_POST_FLOOR) {
    return new Response(`forum looks healthy (${posts} posts); refusing to restart\n`, { status: 409 });
  }
  await container.stop().catch(() => {});
  return new Response(`forum had ${posts} posts, which means the restore failed; restarting to re-import\n`);
}

// Pre-fill crawler-view snapshots for recent topics while the container is warm after
// the nightly recycle. Hard deadline: this rides time the recycle already paid for and
// must never extend awake time meaningfully. Coverage strategy: recent topics nightly
// here, the long tail organically (every real crawler hit persists its own snapshot),
// converging toward full coverage.
async function warmSnapshots(
  env: Env,
  container: { fetch(req: Request): Promise<Response> },
  deadlineMs: number,
): Promise<void> {
  const snapshots = env.SNAPSHOTS;
  if (!snapshots) return;
  const listing = await container.fetch(
    new Request("https://forum.internal/sitemap_recent.xml", { headers: { "user-agent": "cf-snapshot-warmer" } }),
  );
  if (listing.status !== 200) return;
  const xml = await listing.text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => {
      try {
        return new URL(m[1]).pathname;
      } catch {
        return null;
      }
    })
    .filter((p): p is string => Boolean(p));
  let warmed = 0;
  for (const p of paths) {
    if (Date.now() > deadlineMs) break;
    try {
      const r = await container.fetch(
        new Request(`https://forum.internal${p}`, {
          // crawler UA → Discourse serves the crawler layout, i.e. the exact document
          // a real crawler will be handed from this snapshot later
          headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", accept: "text/html" },
        }),
      );
      if (r.status !== 200) continue;
      const buf = await r.arrayBuffer();
      await snapshots.put(`snap${p}|__view=crawler`, buf, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { cachedAt: String(Date.now()) },
      });
      warmed++;
    } catch {
      /* next page */
    }
  }
  console.log(`snapshot warmer: ${warmed}/${paths.length} pages persisted`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const container = getContainer(env.DISCOURSE, "forum");
    const url = new URL(request.url);

    // Canonical funnel: non-canonical hosts and plain HTTP 301 to the forum hostname
    // over https, so links, cookies and SEO all converge on one origin.
    if (env.DISCOURSE_HOSTNAME && !env.DISCOURSE_HOSTNAME.includes("REPLACE-ME") &&
        (url.hostname !== env.DISCOURSE_HOSTNAME || url.protocol === "http:")) {
      url.hostname = env.DISCOURSE_HOSTNAME;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    // Ops endpoints, active only when a CF_OPS_KEY secret is configured. `restart` is
    // how a new bootstrap bundle gets picked up: the bundle lives in R2, so a plain
    // `wrangler deploy` does not recycle the container.
    if (url.pathname.startsWith("/_cf/") && env.CF_OPS_KEY) {
      // Prefer `Authorization: Bearer <key>` — a ?key= query string lands in access
      // logs, browser history and Referer headers. The query form stays accepted so
      // existing monitoring scripts keep working; accept whichever matches.
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (bearer !== env.CF_OPS_KEY && url.searchParams.get("key") !== env.CF_OPS_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/_cf/status") {
        const state = await container.getState().catch((e: unknown) => ({ error: String(e) }));
        return Response.json({ container: state, hostname: env.DISCOURSE_HOSTNAME });
      }
      if (url.pathname === "/_cf/restart-when-broken") {
        return healIfBroken(container);
      }
      if (url.pathname === "/_cf/restart") {
        // SIGTERM → the shutdown hook takes a final database backup → clean exit.
        await container.stop().catch(() => {});
        return new Response("restarting; the next request boots a fresh container\n");
      }
    }

    // Edge-cache immutable static assets: Discourse fingerprints everything under
    // these paths and serves it with max-age=1y, but a Worker route bypasses zone
    // caching — without this, every asset request wakes Rails.
    const cacheable = request.method === "GET" && /^\/(assets|stylesheets|images|svg-sprite|fonts)\//.test(url.pathname);
    const cache = caches.default;
    if (cacheable) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    // Anonymous page cache with stale-if-error. Two jobs: (1) repeat anonymous views
    // and crawler hits serve from the edge instead of crossing to Rails; (2) during a
    // container wake — minutes of 503 otherwise — the last good copy is served at ANY
    // age, so visitors and crawlers never see downtime for a page this PoP has seen
    // before. Only cookie-less GETs participate; the key carries a crawler/app bit
    // because the same URL serves two different documents.
    const isCrawler = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit/i.test(
      request.headers.get("user-agent") ?? "",
    );
    const anonCacheable =
      request.method === "GET" &&
      !request.headers.get("cookie") &&
      (wantsHtml(request) || url.pathname === "/latest.json") &&
      !url.pathname.startsWith("/_cf/");
    // The cache key keeps only parameters Discourse listings actually understand.
    // Everything else (?r=123, ?utm_..., cache-busters) collapses onto one entry,
    // which turns a unique-URL billing attack into a stream of edge hits.
    const KEEP_PARAMS = ["page", "order", "ascending", "no_definitions", "filter", "q", "period", "tags"];
    let anonKey: Request | null = null;
    if (anonCacheable) {
      const kept = new URLSearchParams();
      for (const k of KEEP_PARAMS) for (const v of url.searchParams.getAll(k)) kept.append(k, v);
      const qs = kept.toString();
      anonKey = new Request(
        `https://edge-cache.internal${url.pathname}?${qs ? qs + "&" : ""}__view=${isCrawler ? "crawler" : "app"}`,
      );
    }
    const ANON_FRESH_MS = 180_000;

    let staleCopy: Response | undefined;
    if (anonKey) {
      const hit = await cache.match(anonKey);
      if (hit) {
        const cachedAt = Number(hit.headers.get("x-edge-cached-at") ?? 0);
        if (Date.now() - cachedAt < ANON_FRESH_MS) {
          const fresh = new Response(hit.body, hit);
          fresh.headers.set("cache-control", "no-cache");
          fresh.headers.set("x-edge-cache", "fresh-hit");
          return fresh;
        }
        staleCopy = hit; // revalidate below; rescue with this if the origin is down
      }
    }

    const staleRescue = (): Response | null => {
      if (!staleCopy) return null;
      const rescued = new Response(staleCopy.body, staleCopy);
      rescued.headers.set("cache-control", "no-cache");
      rescued.headers.set("x-edge-cache", "stale-rescue");
      return rescued;
    };

    // Deepest tier (optional): the durable R2 snapshot — global rather than per-colo,
    // survives deploys and eviction, served at ANY age when the container can't
    // answer. '|' instead of '?' keeps keys CLI-friendly.
    const snapKey =
      anonKey && env.SNAPSHOTS
        ? "snap" + new URL(anonKey.url).pathname + "|" + new URL(anonKey.url).searchParams.toString()
        : null;
    // Rescue tiers exist to hide wakes, not to republish history: a snapshot may
    // contain topics that were since deleted or unlisted, and without a ceiling it
    // would be served forever (the R2 copy outlives every cache eviction). 30 days
    // bounds that exposure; an older or unstamped snapshot is refused and the
    // request falls through to the waking page.
    const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const snapshotRescue = async (): Promise<Response | null> => {
      if (!snapKey || !env.SNAPSHOTS) return null;
      const obj = await env.SNAPSHOTS.get(snapKey).catch(() => null);
      if (!obj) return null;
      const cachedAt = Number(obj.customMetadata?.cachedAt ?? 0);
      if (!cachedAt || Date.now() - cachedAt > SNAPSHOT_MAX_AGE_MS) return null;
      const h = new Headers();
      h.set("content-type", obj.httpMetadata?.contentType ?? "text/html; charset=utf-8");
      h.set("cache-control", "no-cache");
      h.set("x-edge-cache", "r2-snapshot");
      return new Response(obj.body, { headers: h });
    };

    // Billing-abuse rails — applied only to traffic that would consume container
    // time (edge hits returned above never reach this point).
    const cookieHeader = request.headers.get("cookie") ?? "";
    const loggedIn = cookieHeader.includes("_t=");
    if (!loggedIn) {
      if (env.WAKE_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const verdict = await env.WAKE_LIMITER.limit({ key: ip }).catch(() => ({ success: true }));
        if (!verdict.success) {
          return staleRescue() ?? new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
        }
      }
      // Wake gate: while the container sleeps, only logged-in users, Cloudflare-
      // verified bots (SEO is never throttled), or a browser carrying the waking
      // page's cookie may start it. Everyone else gets a stale copy or the waking
      // page — a cookie-less loop can sit on a URL forever without waking anything.
      const verifiedBot = Boolean((request.cf as { verifiedBotCategory?: string } | undefined)?.verifiedBotCategory);
      // API automation authenticates with Api-Key headers, never cookies — it must
      // always be able to wake the forum.
      const apiClient = request.headers.has("api-key") || request.headers.has("user-api-key");
      if (!verifiedBot && !apiClient && !cookieHeader.includes("cf_wake=")) {
        const state = await container.getState().catch(() => null);
        const awake = state !== null && /running|healthy|starting/i.test(JSON.stringify(state));
        if (!awake) {
          const rescued = staleRescue() ?? (await snapshotRescue());
          if (rescued) {
            // A rescue answers this request but leaves the visitor cookie-less, and
            // every later request of theirs would be rescued too — a visitor whose
            // pages all have cached copies could never wake the forum at all. Plant
            // the wake cookie here so their next navigation passes the gate.
            rescued.headers.append("set-cookie", WAKE_COOKIE);
            return rescued;
          }
          if (wantsHtml(request)) return wakingResponse(true);
          return new Response("origin sleeping", { status: 503, headers: { "retry-after": "30" } });
        }
      }
    }

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", "https");
    const proxied = new Request(request, { headers });
    try {
      const res = await container.fetch(proxied);
      if (res.status === 502 || res.status === 503) {
        const rescued = staleRescue() ?? (await snapshotRescue());
        if (rescued) return rescued;
        if (wantsHtml(request)) return wakingResponse();
        return res;
      }
      if (cacheable && res.status === 200 && (res.headers.get("cache-control") ?? "").includes("max-age")) {
        const copy = new Response(res.body, res);
        copy.headers.set("strict-transport-security", "max-age=31536000");
        const [toClient, toCache] = [copy.clone(), copy];
        ctx.waitUntil(cache.put(request, toCache));
        return toClient;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (res.status === 200 && contentType.includes("text/html")) {
        const page = new Response(res.body, res);
        page.headers.set("strict-transport-security", "max-age=31536000");
        if (anonKey) {
          const toStore = page.clone();
          const stored = new Response(toStore.body, toStore);
          // cache.put refuses no-store responses, and expired entries are never
          // returned by cache.match — so the stored copy gets a long TTL and the
          // freshness window is enforced by x-edge-cached-at above.
          stored.headers.set("cache-control", "public, max-age=86400");
          // cache.put poisons: Vary breaks matching, and the runtime already decoded
          // the body so the origin's encoding/length claims are wrong for the stored
          // bytes.
          for (const h of ["set-cookie", "vary", "content-encoding", "content-length", "transfer-encoding"]) stored.headers.delete(h);
          stored.headers.set("x-edge-cached-at", String(Date.now()));
          ctx.waitUntil(cache.put(anonKey, stored));
          // durable tier (optional): same bytes, survives sleeps/deploys/eviction globally
          if (snapKey && env.SNAPSHOTS) {
            const snapCopy = page.clone();
            ctx.waitUntil(
              (async () => {
                const buf = await snapCopy.arrayBuffer();
                await env.SNAPSHOTS!.put(snapKey, buf, {
                  httpMetadata: { contentType: "text/html; charset=utf-8" },
                  customMetadata: { cachedAt: String(Date.now()) },
                });
              })().catch(() => {}),
            );
          }
        }
        return page;
      }
      if (anonKey && res.status === 200 && contentType.includes("json")) {
        const copy = new Response(res.body, res);
        const [toClient, toStore] = [copy.clone(), copy];
        const stored = new Response(toStore.body, toStore);
        stored.headers.set("cache-control", "public, max-age=86400");
        // cache.put poisons: Vary breaks matching, and the runtime already decoded the
        // body so the origin's encoding/length claims are wrong for the stored bytes.
        for (const h of ["set-cookie", "vary", "content-encoding", "content-length", "transfer-encoding"]) stored.headers.delete(h);
        stored.headers.set("x-edge-cached-at", String(Date.now()));
        ctx.waitUntil(cache.put(anonKey, stored));
        if (snapKey && env.SNAPSHOTS) {
          const snapCopy = toClient.clone();
          ctx.waitUntil(
            (async () => {
              const buf = await snapCopy.arrayBuffer();
              await env.SNAPSHOTS!.put(snapKey, buf, {
                httpMetadata: { contentType: "application/json" },
                customMetadata: { cachedAt: String(Date.now()) },
              });
            })().catch(() => {}),
          );
        }
        return toClient;
      }
      return res;
    } catch {
      const rescued = staleRescue() ?? (await snapshotRescue());
      if (rescued) return rescued;
      if (wantsHtml(request)) return wakingResponse();
      return new Response("container starting, retry shortly", { status: 503, headers: { "retry-after": "15" } });
    }
  },

  // Nightly auto-update: top up the snapshot tier (if configured) within a strict
  // time budget, then a graceful stop (SIGTERM → final DB backup → clean shutdown),
  // then an immediate request so the container comes back on the newest Discourse
  // image with migrations applied. No admin action, ever.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const container = getContainer(env.DISCOURSE, "forum");
    ctx.waitUntil(
      (async () => {
        // Warm BEFORE stopping: right now the outgoing container is up and serving
        // real pages; after the stop the replacement can only produce the waking
        // screen for several minutes, so post-stop warming would persist that
        // instead of content. If the container is already asleep the listing fetch
        // fails fast and the warmer is a no-op; the deadline bounds it either way.
        if (env.SNAPSHOTS) {
          try {
            await warmSnapshots(env, container, Date.now() + 45_000);
          } catch (e) {
            console.log("snapshot warmer:", String(e));
          }
        }
        try {
          await container.stop();
        } catch (e) {
          console.log("scheduled stop failed (container may be asleep):", String(e));
        }
        // Wake it back up so the update lands now rather than on a visitor's request.
        try {
          await container.fetch(new Request("https://forum.internal/"));
        } catch {
          /* boot continues in the background; the next visitor gets the waking page */
        }
      })(),
    );
  },
};
