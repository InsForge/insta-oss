// Appends OPENCLAW_PUBLIC_URL to gateway.controlUi.allowedOrigins if it is not already listed.
// Append rather than overwrite: a branch clone boots with the parent's config and its own URL,
// and origins the user added by hand must survive restarts.
import { execFileSync } from "node:child_process";

const url = (process.env.OPENCLAW_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
if (!url) process.exit(0);

let current = [];
try {
  const out = execFileSync(
    "node",
    ["openclaw.mjs", "config", "get", "gateway.controlUi.allowedOrigins"],
    { encoding: "utf8" },
  ).trim();
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed)) current = parsed.filter((o) => typeof o === "string");
} catch {
  // No config yet, or an unreadable value: start from an empty list.
}

if (current.includes(url)) process.exit(0);

execFileSync(
  "node",
  [
    "openclaw.mjs",
    "config",
    "set",
    "--batch-json",
    JSON.stringify([{ path: "gateway.controlUi.allowedOrigins", value: [...current, url] }]),
  ],
  { stdio: "ignore" },
);
