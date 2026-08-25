// First Control UI connection needs one-time device-pairing approval, which upstream expects
// you to run on the gateway host (`openclaw devices approve`) — and this platform offers no
// shell into the machine. Approve pending requests from inside instead: a pairing request is
// only created after gateway token auth succeeded, so possession of the token already gates.
import { execFileSync } from "node:child_process";

const base = ["--url", "ws://127.0.0.1:8080"];
const token = (process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
if (token) base.push("--token", token);

const run = (args) =>
  execFileSync("node", ["openclaw.mjs", ...args, ...base], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const tick = () => {
  try {
    const out = JSON.parse(run(["devices", "list", "--json"]));
    for (const p of out?.pending ?? []) {
      if (!p?.requestId) continue;
      run(["devices", "approve", p.requestId, "--json"]);
      console.log(`[template] approved control-ui device ${p.requestId}`);
    }
  } catch {
    // Gateway not up yet, or a transient CLI failure — the next tick retries.
  }
  setTimeout(tick, 15_000);
};

setTimeout(tick, 20_000);
