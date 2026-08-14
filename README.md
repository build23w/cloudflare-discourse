# cloudflare-discourse

Discourse running on Cloudflare Containers, with R2 holding everything that has to survive a restart.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/build23w/cloudflare-discourse)

Discourse is the poster child for "just get a VPS." It's a big Rails app that expects Postgres, Redis, Sidekiq, and a disk that doesn't disappear out from under it. I wanted to see if it could live on Cloudflare's serverless stack instead. It can, and the result is a forum that costs about as much as a cheap VPS but never needs to be updated, patched, or SSH'd into.

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

## How it works

Nothing gets built, anywhere. Cloudflare pulls the official `discourse/base:release` image straight from Docker Hub, and your customization travels as a small bundle in R2 that the container fetches and applies at boot. You never run Docker on your own machine, and there's no CI pipeline or registry involved.

The self-updating behavior falls out of that design almost for free. Discourse rebuilds the `:release` tag continuously, every cold start pulls whatever is newest and runs `db:migrate`, and a nightly cron recycles the container so updates land even if nobody visits. Plugins are re-cloned on each boot, so they track their upstreams too. You can run this for a year and never type an update command.

The container's disk is ephemeral, so durability lives entirely in R2. Uploads go there directly through Discourse's native S3 support. Postgres gets dumped to R2 every 15 minutes and again on SIGTERM, which covers deploys, sleep, and the nightly recycle; the next boot restores the latest dump. Precompiled assets are cached in R2 as well, keyed by Discourse commit plus plugin set, so the slow ember build happens once per version instead of once per boot.

Mail goes through Cloudflare Email Service by default (SMTP submission with implicit TLS on 465, DKIM and ARC signed for you), so you don't need a third-party ESP unless you want one.

## Quick start

```bash
git clone https://github.com/build23w/cloudflare-discourse && cd cloudflare-discourse
npm install
npx wrangler login
```

Edit `wrangler.jsonc`: set `DISCOURSE_HOSTNAME`, `DISCOURSE_ADMIN_EMAIL`, and `CF_R2_ENDPOINT` (your account ID). Then:

```bash
npm run bootstrap
```

That creates the R2 buckets, uploads the boot bundle, deploys the Worker, and prompts for the secrets it needs. The first visit boots the container. Fair warning: the very first boot precompiles assets and takes 15 to 25 minutes. It only happens once; later wakes take a few minutes.

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

Email stays globally disabled until `DISCOURSE_SMTP_PASSWORD` exists, then switches on by itself. Onboard your sending domain under Email Service → Email Sending in the dashboard first. If you'd rather use another provider, point `DISCOURSE_SMTP_ADDRESS`/`_PORT`/`_USER_NAME` at it; port 465 uses implicit TLS, anything else uses STARTTLS.

## Migrating an existing Discourse

Any standard `discourse_docker` install can be imported without taking the source down:

```bash
npm run migrate -- --host root@your-server -p 22
```

It streams `pg_dump` and local uploads straight into R2, then the next container boot restores them, migrates the schema, and rebuilds assets. If your old forum already stores uploads on S3 or R2, nothing gets copied. Those settings live in the database and carry over, so the new forum keeps serving the same files.

## Operating it

```bash
npm run update    # only for changes to YOUR files (bundle/worker); Discourse updates itself
npm run logs      # worker tail; container output is in the dashboard
npm run backup    # force an immediate pg dump to R2
```

The forum sleeps after 4 hours idle and compute billing stops. The first visitor after that gets an auto-refreshing waking page. To scale, bump `instance_type` in `wrangler.jsonc` and `UNICORN_WORKERS` in `src/index.ts`.

## License

MIT****
