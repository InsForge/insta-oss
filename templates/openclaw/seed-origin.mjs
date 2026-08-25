// Makes the Control UI reachable from this deployment's public origin before the gateway starts:
// appends OPENCLAW_PUBLIC_URL to gateway.controlUi.allowedOrigins when the platform injects it,
// else enables the Host-header origin fallback — behind the platform proxy the Host header is
// pinned to the routed domain, and gateway auth still requires the token either way.
// Writes the config file directly rather than shelling out to the openclaw CLI: on a cold root
// filesystem each CLI run costs ~10s, which eats the first-deploy health budget.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const stateDir =
  process.env.OPENCLAW_STATE_DIR || join(process.env.HOME ?? "/home/node", ".openclaw");
const path = process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");

let cfg = {};
if (existsSync(path)) {
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // An existing config we cannot parse must not be clobbered; leave it to the gateway.
    console.error(`[template] ${path} exists but is not parseable JSON; skipping origin seeding`);
    process.exit(0);
  }
}

const controlUi = ((cfg.gateway ??= {}).controlUi ??= {});
const origins = Array.isArray(controlUi.allowedOrigins)
  ? controlUi.allowedOrigins.filter((o) => typeof o === "string")
  : [];
const url = (process.env.OPENCLAW_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

if (url && !origins.includes(url)) {
  // Append rather than overwrite: a branch clone boots with the parent's config and its own
  // URL, and origins the user added by hand must survive restarts.
  controlUi.allowedOrigins = [...origins, url];
} else if (!url && origins.length === 0) {
  controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log(`[template] control UI origin ready (${url ? url : "host-header fallback"})`);
