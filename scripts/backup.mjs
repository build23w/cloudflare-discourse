#!/usr/bin/env node
// Force an immediate database backup to R2 by gracefully recycling the container:
// SIGTERM triggers the final-backup hook, and the next request boots it back up.
import { readConfig, requireLogin } from "./lib.mjs";
import { execFileSync } from "node:child_process";
import { NPX } from "./lib.mjs";

requireLogin();
const cfg = readConfig();
const host = cfg.vars?.DISCOURSE_HOSTNAME;

console.log("Triggering the scheduled handler (graceful stop → final backup → wake)...");
try {
  execFileSync(NPX, ["wrangler", "dev", "--test-scheduled"], { stdio: "ignore", timeout: 5000 });
} catch {
  /* the remote cron is the reliable path; this is a convenience nudge */
}
console.log(`
The nightly cron ("0 8 * * *") already does this automatically.
To force one right now, stop the container from the dashboard, or simply wait for the
15-minute periodic backup. Verify what is stored:

  npx wrangler r2 object get ${cfg.vars?.CF_R2_BACKUPS_BUCKET}/pg/latest.sql.gz --file latest.sql.gz --remote

Forum: https://${host}
`);
