#!/usr/bin/env node
// One command from empty account to running forum. Nothing is built locally.
import { wrangler, wranglerOut, readConfig, bundle, requireLogin, die } from "./lib.mjs";
import { writeFileSync, readFileSync } from "node:fs";

requireLogin();
const cfg = readConfig();
const vars = cfg.vars ?? {};

if (String(vars.CF_R2_ENDPOINT).includes("REPLACE-ACCOUNT-ID")) {
  die("Set CF_R2_ENDPOINT in wrangler.jsonc to https://<your-account-id>.r2.cloudflarestorage.com first.");
}

console.log("\n== creating R2 buckets (ignore 'already exists') ==");
for (const b of [vars.CF_R2_UPLOADS_BUCKET, vars.CF_R2_BACKUPS_BUCKET]) {
  try {
    wrangler(["r2", "bucket", "create", b]);
  } catch {
    console.log(`  ${b}: already exists`);
  }
}

console.log("\n== uploading boot bundle to R2 ==");
bundle();
wrangler(["r2", "object", "put", `${vars.CF_R2_BACKUPS_BUCKET}/bootstrap/bundle.tar.gz`, "--file", "bundle.tar.gz", "--remote"]);

console.log("\n== deploying worker + container ==");
const out = wranglerOut(["deploy"]);
process.stdout.write(out);

const host = out.match(/https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/)?.[1];
if (host && String(vars.DISCOURSE_HOSTNAME).includes("REPLACE-ME")) {
  const raw = readFileSync("wrangler.jsonc", "utf8").replace(/REPLACE-ME\.workers\.dev/, host);
  writeFileSync("wrangler.jsonc", raw);
  console.log(`\nDISCOURSE_HOSTNAME set to ${host} — redeploying so the container sees it`);
  wrangler(["deploy"]);
}

console.log(`
== secrets ==
Set these now (each opens a prompt; values are never written to disk):

  npx wrangler secret put R2_ACCESS_KEY_ID
  npx wrangler secret put R2_SECRET_ACCESS_KEY
  npx wrangler secret put DISCOURSE_ADMIN_PASSWORD
  npx wrangler secret put DISCOURSE_SMTP_PASSWORD    # Cloudflare API token, "Email Sending: Edit"

Then visit https://${host ?? vars.DISCOURSE_HOSTNAME}
The first boot precompiles assets (15-25 min, once). Later wakes take a few minutes.
`);
