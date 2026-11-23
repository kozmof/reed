import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = fileURLToPath(new URL("../.npm-cache", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.length === 1 && args[0] === "--dry-run";
if (args.length && !dryRun) {
  throw new Error("Usage: pnpm release:publish [--dry-run]");
}

let config = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG;

function npm(command, options = [], stdio = "inherit") {
  const flags = ["--registry=https://registry.npmjs.org/", `--cache=${cache}`];
  if (config) flags.push(`--userconfig=${config}`);
  return execFileSync("npm", [command, ...options, ...flags], {
    cwd: root,
    encoding: "utf8",
    stdio,
  });
}

function isAuthenticated() {
  try {
    npm("whoami", [], "pipe");
    return true;
  } catch (error) {
    if (/\b(?:ENEEDAUTH|E401)\b/.test(error.stderr ?? "")) return false;
    throw error;
  }
}

let authDirectory;
try {
  if (!dryRun && !isAuthenticated()) {
    if (!config) {
      const temporaryRoot = join(root, "tmp");
      mkdirSync(temporaryRoot, { recursive: true });
      authDirectory = mkdtempSync(join(temporaryRoot, "npm-auth-"));
      config = join(authDirectory, "npmrc");
      closeSync(openSync(config, "wx", 0o600));
    }
    npm("login");
    npm("whoami");
  }

  npm("publish", ["--access", "public", "--ignore-scripts", ...args]);
} finally {
  if (authDirectory) rmSync(authDirectory, { recursive: true, force: true });
}
