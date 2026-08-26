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
      // Only fresh Control UI pairings: no node roles, no repair/upgrade of an existing device —
      // those stay manual, and a stuck browser can always pair again as a new device.
      if (p.isRepair) continue;
      const roles = p.roles ?? (p.role ? [p.role] : []);
      if (roles.some((r) => r !== "operator")) continue;
      if (p.clientId && p.clientId !== "openclaw-control-ui") continue;
      run(["devices", "approve", p.requestId, "--json"]);
      console.log(
        `[template] approved control-ui device ${p.requestId} (${p.displayName ?? p.clientId ?? "unnamed"} from ${p.remoteIp ?? "unknown ip"})`,
      );
    }
  } catch {
    // Gateway not up yet, or a transient CLI failure — the next tick retries.
  }
  setTimeout(tick, 15_000);
};

setTimeout(tick, 20_000);
