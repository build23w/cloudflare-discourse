# cloudflare-discourse

**Real Discourse. Entirely on Cloudflare. No servers, no Docker, no build step.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/build23w/cloudflare-discourse)

Discourse is a Rails app that wants Postgres, Redis, Sidekiq and a persistent disk —
the classic "you need a VPS" workload. This runs it on Cloudflare Containers behind a
Worker, with R2 for durability, and it **updates itself**.

```
                 ┌─ Cloudflare ──────────────────────────────────────────┐
 browser ─https─►│ Worker  (router + cold-start splash + nightly cron)   │
                 │   └► Durable Object                                   │
                 │        └► Container: nginx · pitchfork · sidekiq      │
                 │                      postgres 18 · redis              │
                 │           image: docker.io/discourse/base:release     │
                 │           (pulled by Cloudflare, rebuilt upstream)    │
                 │                                                       │
                 │ R2 discourse-uploads  → user uploads (native S3)      │
                 │ R2 discourse-backups  → pg dumps, boot bundle, assets │
                 │ Email Service         → transactional mail over SMTP  │
                 └───────────────────────────────────────────────────────┘
```

## What makes this different

- **Nothing is built anywhere.** Cloudflare pulls the official `discourse/base` image
  straight from Docker Hub. Your customization travels as a small bundle in R2 that the
  container fetches and applies at boot. No local Docker, no CI, no registry push.
- **It updates itself.** Discourse rebuilds `:release` continuously. Every cold start
  pulls the newest image and runs `db:migrate`; a nightly cron recycles the container so
  updates land even with no visitors. **An admin never runs an update.** Plugins are
  re-cloned each boot, so they track their upstreams too.
- **Ephemeral disk, durable data.** Uploads go to R2 through Discourse's native S3
  support. Postgres is dumped to R2 every 15 minutes *and* on SIGTERM (deploys, sleep,
  nightly recycle), then restored on the next boot.
- **Assets are cached.** Precompiled assets are stored in R2 keyed by Discourse commit +
  plugin set, so the expensive ember build happens once per version, not once per boot.
- **Email included.** Cloudflare Email Service is the default mail path (SMTP submission,
  implicit TLS on 465, DKIM/ARC signed for you) — no third-party ESP required.

## Quick start

```bash
git clone https://github.com/build23w/cloudflare-discourse && cd cloudflare-discourse
npm install
npx wrangler login
```

Edit `wrangler.jsonc`: set `DISCOURSE_HOSTNAME`, `DISCOURSE_ADMIN_EMAIL`, and
`CF_R2_ENDPOINT` (your account ID). Then:

```bash
npm run bootstrap
```

That creates the R2 buckets, uploads the boot bundle, deploys the Worker, and prompts for
the secrets it needs. First visit boots the container; the very first boot precompiles
assets (~15-25 min, once), later wakes take a few minutes.

### Secrets

| Secret | What it is |
| --- | --- |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token (S3-compatible credentials) |
| `DISCOURSE_ADMIN_PASSWORD` | password for the admin account created on first boot |
| `DISCOURSE_SMTP_PASSWORD` | Cloudflare API token with **Email Sending: Edit** |

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put DISCOURSE_ADMIN_PASSWORD
npx wrangler secret put DISCOURSE_SMTP_PASSWORD
```

Email stays globally disabled until `DISCOURSE_SMTP_PASSWORD` exists, then switches on by
itself. Onboard your sending domain under **Email Service → Email Sending** in the
dashboard first. Prefer another provider? Point `DISCOURSE_SMTP_ADDRESS`/`_PORT`/
`_USER_NAME` at it — port 465 uses implicit TLS, anything else uses STARTTLS.

## Migrating an existing Discourse

Any standard Discourse (a `discourse_docker` VPS install) can be imported without
downtime on the source:

```bash
npm run migrate -- --host root@your-server -p 22
```

It streams `pg_dump` and local uploads straight into R2, then the next container boot
restores them, migrates the schema, and rebuilds assets. If your old forum already stores
uploads on S3/R2, nothing is copied — those settings live in the database and carry over,
so the new forum keeps serving the same files.

## Operating it

```bash
npm run update    # only for changes to YOUR files (bundle/worker) — Discourse self-updates
npm run logs      # worker tail; container output is in the dashboard
npm run backup    # force an immediate pg dump to R2
```

- Sleeps after 4h idle (compute billing stops); the first visitor gets an auto-refreshing
  waking page.
- Scale vertically: `instance_type` in `wrangler.jsonc` + `UNICORN_WORKERS` in `src/index.ts`.
- Rough cost: Workers Paid $5/mo + container compute while awake + R2 pennies.
  A small, quiet forum lands around $10-25/mo.

## Trade-offs (read before you commit)

- **Cold starts.** An idle forum takes a few minutes to wake. Set `sleepAfter` longer, or
  keep it hot with a cron ping, if that matters.
- **One instance.** `max_instances: 1` by design — Postgres and Redis live inside the
  container. This scales up, not out. That is how most self-hosted Discourse runs anyway.
- **Crash window.** A hard crash (no SIGTERM) can lose up to one backup interval. Tune
  `CF_BACKUP_INTERVAL_SECONDS`. Graceful paths always flush first.
- **Docker Hub pulls** are uncached and rate-limited for anonymous clients. If wakes ever
  429, push the base image into Cloudflare's registry once and point `image` at it.
- **No `docker_manager`.** The in-app update UI is deliberately absent — it has no
  launcher to drive here. Updates happen by recycling the container.

## License

MIT
