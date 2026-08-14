#!/usr/bin/env node
// Import an existing Discourse (a standard discourse_docker install) into this one.
// Streams pg_dump + local uploads from the source host straight into R2 — nothing
// large ever lands on your laptop, and the source forum keeps serving throughout.
//
//   node scripts/migrate.mjs --host root@1.2.3.4 [-p 22] [--container app]
//
// Requires: ssh on PATH, key-based auth to the source host.
import { execFileSync } from "node:child_process";
import { readConfig, requireLogin, die } from "./lib.mjs";

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};

const host = arg("--host");
const port = arg("-p", "22");
const dockerName = arg("--container", "app");
if (!host) die("usage: node scripts/migrate.mjs --host root@SERVER [-p PORT] [--container NAME]");

requireLogin();
const cfg = readConfig();
const vars = cfg.vars ?? {};
const bucket = vars.CF_R2_BACKUPS_BUCKET ?? "discourse-backups";
const endpoint = vars.CF_R2_ENDPOINT;

const ak = process.env.R2_ACCESS_KEY_ID;
const sk = process.env.R2_SECRET_ACCESS_KEY;
if (!ak || !sk) {
  die("Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in your environment first (same values as the Worker secrets).");
}

// Everything below runs ON the source host, detached, so a dropped SSH session
// cannot interrupt a multi-gigabyte transfer.
const remote = `
set -e
command -v rclone >/dev/null || { apt-get update -y && apt-get install -y rclone; }
cat > /root/.cfd-r2.env <<'ENVEOF'
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=${ak}
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${sk}
export RCLONE_CONFIG_R2_ENDPOINT=${endpoint}
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
ENVEOF
cat > /root/.cfd-migrate.sh <<'SCRIPTEOF'
#!/bin/bash
trap 'rm -f /root/.cfd-r2.env /root/.cfd-migrate.sh' EXIT
source /root/.cfd-r2.env
exec >/tmp/cfd-migrate.log 2>&1
set -x
PGD=\$(docker exec ${dockerName} bash -lc 'command -v pg_dump || ls /usr/lib/postgresql/*/bin/pg_dump | head -1')
docker exec ${dockerName} su postgres -c "\$PGD --no-owner --no-privileges discourse" | gzip -6 \
  | rclone rcat r2:${bucket}/migration/seed.sql.gz
tar czf - -C /var/discourse/shared/standalone uploads | rclone rcat r2:${bucket}/migration/uploads.tgz
echo pending | rclone rcat r2:${bucket}/migration/pending
echo "MIGRATION EXPORT DONE"
SCRIPTEOF
chmod +x /root/.cfd-migrate.sh
nohup /root/.cfd-migrate.sh >/dev/null 2>&1 &
echo "export started on source; watch with: tail -f /tmp/cfd-migrate.log"
`;

console.log(`Starting export on ${host} ...`);
execFileSync("ssh", ["-p", port, host, "bash -s"], { input: remote, stdio: ["pipe", "inherit", "inherit"] });

console.log(`
Export is running on the source host (safe to close this terminal).
Watch it:      ssh -p ${port} ${host} 'tail -f /tmp/cfd-migrate.log'
When it prints MIGRATION EXPORT DONE, force a fresh boot:

  npx wrangler deploy && curl -s -o /dev/null https://${vars.DISCOURSE_HOSTNAME}/

The next container boot restores the database, keeps any existing S3/R2 upload
settings from the source, migrates the schema, and rebuilds assets.
`);
