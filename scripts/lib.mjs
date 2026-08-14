import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

export function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

export function shOut(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function wrangler(args, opts = {}) {
  return execFileSync(NPX, ["wrangler", ...args], { stdio: "inherit", ...opts });
}

export function wranglerOut(args) {
  return execFileSync(NPX, ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// wrangler.jsonc is JSON with comments; strip them rather than adding a dependency.
export function readConfig(path = "wrangler.jsonc") {
  const raw = readFileSync(path, "utf8");
  const stripped = raw
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

export function bundle() {
  // tar ships with Windows 10+, macOS and Linux
  sh("tar -czf bundle.tar.gz -C container files");
}

export function requireLogin() {
  try {
    execFileSync(NPX, ["wrangler", "whoami"], { stdio: "ignore" });
  } catch {
    console.log("Not logged in — starting browser OAuth...");
    wrangler(["login"]);
  }
}

export function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
