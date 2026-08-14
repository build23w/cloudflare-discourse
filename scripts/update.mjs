#!/usr/bin/env node
// Push changes to YOUR files (container/files/**, src/**, wrangler.jsonc).
// Discourse itself needs no help: it updates on every cold start.
import { wrangler, readConfig, bundle, requireLogin } from "./lib.mjs";

requireLogin();
const cfg = readConfig();
const backups = cfg.vars?.CF_R2_BACKUPS_BUCKET ?? "discourse-backups";

bundle();
wrangler(["r2", "object", "put", `${backups}/bootstrap/bundle.tar.gz`, "--file", "bundle.tar.gz", "--remote"]);
wrangler(["deploy"]);

console.log(`
Deployed. The new bundle applies on the container's next cold start; the outgoing
instance takes a final database backup on SIGTERM and the new one restores it.
`);
