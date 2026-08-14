import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  DISCOURSE: DurableObjectNamespace;
  DISCOURSE_HOSTNAME: string;
  DISCOURSE_ADMIN_EMAIL: string;
  DISCOURSE_ADMIN_USERNAME: string;
  CF_R2_ENDPOINT: string;
  CF_R2_UPLOADS_BUCKET: string;
  CF_R2_BACKUPS_BUCKET: string;
  CF_PLUGINS: string;
  DISCOURSE_SMTP_ADDRESS: string;
  DISCOURSE_SMTP_PORT: string;
  // secrets
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  DISCOURSE_ADMIN_PASSWORD?: string;
  DISCOURSE_SMTP_USER_NAME?: string;
  DISCOURSE_SMTP_PASSWORD?: string;
}

// Stock discourse/base image + this entrypoint: pull the bootstrap bundle from R2
// (curl signs the request itself with sigv4) and hand off to cf-boot.
const ENTRYPOINT_SCRIPT = [
  "set -e",
  'if [ -z "$CF_R2_ACCESS_KEY_ID" ]; then echo "[cf-entry] no R2 secrets yet"; sleep 30; exit 1; fi',
  'echo "[cf-entry] fetching bootstrap bundle"',
  "mkdir -p /cf",
  'curl -fsSL --retry 5 --aws-sigv4 aws:amz:auto:s3 --user "$CF_R2_ACCESS_KEY_ID:$CF_R2_SECRET_ACCESS_KEY" "$CF_R2_ENDPOINT/$CF_R2_BACKUPS_BUCKET/bootstrap/bundle.tar.gz" -o /cf/bundle.tar.gz',
  "tar xzf /cf/bundle.tar.gz -C /cf",
  "exec bash /cf/files/usr/local/bin/cf-boot",
].join("; ");

export class Discourse extends Container<Env> {
  defaultPort = 80;
  sleepAfter = "4h";
  entrypoint = ["/bin/bash", "-c", ENTRYPOINT_SCRIPT];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const smtpOn = Boolean(env.DISCOURSE_SMTP_PASSWORD);
    this.envVars = {
      // --- Discourse global settings (become discourse.conf at boot) ---
      DISCOURSE_HOSTNAME: env.DISCOURSE_HOSTNAME,
      DISCOURSE_DEVELOPER_EMAILS: env.DISCOURSE_ADMIN_EMAIL ?? "",
      RAILS_ENV: "production",
      // 2 web workers fit the default standard-2 (1 vCPU / 6 GiB) alongside postgres,
      // redis and sidekiq. Raise this when you raise instance_type.
      UNICORN_WORKERS: "2",
      UNICORN_SIDEKIQS: "1",
      DISCOURSE_DB_SOCKET: "/var/run/postgresql",
      // Cloudflare fronts the container: trust its forwarded client IP
      DISCOURSE_REAL_IP_HEADER: "CF-Connecting-IP",
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

function wakingResponse(): Response {
  return new Response(WAKING_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "retry-after": "15", "cache-control": "no-store" },
  });
}

function wantsHtml(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.DISCOURSE, "forum");
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", "https");
    const proxied = new Request(request, { headers });
    try {
      const res = await container.fetch(proxied);
      if ((res.status === 502 || res.status === 503) && wantsHtml(request)) return wakingResponse();
      return res;
    } catch {
      if (wantsHtml(request)) return wakingResponse();
      return new Response("container starting, retry shortly", { status: 503, headers: { "retry-after": "15" } });
    }
  },

  // Nightly auto-update: graceful stop (SIGTERM → final DB backup → clean shutdown),
  // then an immediate request so the container comes back on the newest Discourse image
  // with migrations applied. No admin action, ever.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const container = getContainer(env.DISCOURSE, "forum");
    ctx.waitUntil(
      (async () => {
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
