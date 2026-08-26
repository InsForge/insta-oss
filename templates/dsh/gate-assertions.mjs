// Every property the nginx gate in front of dsh is supposed to have, as assertions against a
// running container. The README and the QA row both say to re-test on a DSH_VERSION bump, and
// the pinned upstream is a release candidate whose transitive ranges float, so that is a
// scheduled event rather than a hypothetical. This is what to run.
//
//   ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs http://127.0.0.1:8080
//   ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs https://your-deployment.example.com
//
// Needs the harness actually serving behind the gate, not just nginx: an authenticated request
// answers 502 until dsh is listening, which the health check does not catch (QA.md finding 8).
// No dependencies, and it prints no secret.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createHash } from "node:crypto";

const BASE = process.argv[2];
const USERNAME = process.env.ADMIN_USERNAME;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!BASE || !USERNAME || !PASSWORD) {
  console.error("usage: ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs <base-url>");
  process.exit(2);
}
const url = new URL(BASE);
const TLS = url.protocol === "https:";
const HOST = url.hostname;
const PORT = Number(url.port || (TLS ? 443 : 80));
const AUTHORITY = url.port ? `${HOST}:${url.port}` : HOST;
const SELF = `${url.protocol}//${AUTHORITY}`;

const BASIC = "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
const WRONG = "Basic " + Buffer.from(`${USERNAME}:definitely-not-it`).toString("base64");
// Must match the derivation in entrypoint.sh, which is the contract being asserted.
const TOKEN = createHash("sha256").update(`dsh-gate-cookie-v1:${USERNAME}:${PASSWORD}`).digest("hex");
const COOKIE = `dsh_gate=${TOKEN}`;
const FORGED = "dsh_gate=" + "f".repeat(64);
const FOREIGN = "https://sibling.example.com";
// Same host and port, other scheme. A different origin, and cookies do not distinguish the two.
const OTHER_SCHEME = `${TLS ? "http" : "https"}://${AUTHORITY}`;

let passed = 0;
let failed = 0;
const check = (name, want, got) => {
  const ok = String(want) === String(got);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} -> ${got}${ok ? "" : `   (want ${want})`}`);
  if (ok) passed++;
  else failed++;
};
// For a decision this gate owns while the answer after it is upstream's to change.
// A real status only: a probe that errors or times out must not read as "not 401".
const checkNot = (name, unwanted, got) => {
  const ok = Number.isInteger(got) && String(unwanted) !== String(got);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} -> ${got}${ok ? "" : `   (must be a status other than ${unwanted})`}`);
  if (ok) passed++;
  else failed++;
};

// Raw sockets throughout, because an upgrade cannot be expressed with fetch.
// A plain request sends `Connection: close` and is read to the end, so an assertion about a
// header or an RPC body cannot pass or fail on where the packets happened to split. An upgrade
// has no end to wait for, so that one stops once the headers are complete.
const raw = (lines, readToEnd) =>
  new Promise((resolve) => {
    const opts = { host: HOST, port: PORT, servername: HOST, ALPNProtocols: ["http/1.1"] };
    const socket = TLS ? tlsConnect(opts, send) : netConnect(PORT, HOST, send);
    function send() { socket.write(lines.join("\r\n")) }
    let buf = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ code: code ?? Number(buf.split(" ")[1]), text: buf });
    };
    socket.on("data", (d) => {
      buf += d;
      if (!readToEnd && buf.includes("\r\n\r\n")) finish();
    });
    socket.on("end", () => finish());
    socket.on("error", (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish("TIMEOUT"), 20000);
  });

const req = (method, path, headers = {}, body = "") =>
  raw([`${method} ${path} HTTP/1.1`, `Host: ${AUTHORITY}`, "Connection: close",
    ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`, "Content-Type: application/json"] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", body], true);

const upgrade = (path, headers = {}, value = "websocket") =>
  raw([`GET ${path} HTTP/1.1`, `Host: ${AUTHORITY}`, `Upgrade: ${value}`, "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""], false);

const rpc = (method, payload = {}, headers = {}) =>
  req("POST", `/api/${method}`, { Authorization: BASIC, ...headers },
    JSON.stringify({ type: "client-request", rpcId: "1", method, payload }));

console.log("== the password gate ==");
check("GET / with no credentials", 401, (await req("GET", "/")).code);
check("GET / with the password", 200, (await req("GET", "/", { Authorization: BASIC })).code);
check("GET / with a wrong password", 401, (await req("GET", "/", { Authorization: WRONG })).code);

console.log("\n== the cookie, which may authenticate a handshake and nothing else ==");
const authed = await req("GET", "/", { Authorization: BASIC });
check("an authenticated 200 mints one", true, /set-cookie: dsh_gate=[0-9a-f]{64}/i.test(authed.text));
check("  HttpOnly", true, /HttpOnly/i.test(authed.text));
check("  SameSite=Strict", true, /SameSite=Strict/i.test(authed.text));
check("a 401 mints none", false, /set-cookie/i.test((await req("GET", "/")).text));
check("a holder is not re-minted", false,
  /set-cookie/i.test((await req("GET", "/", { Authorization: BASIC, Cookie: COOKIE })).text));
check("GET / on the cookie alone", 401, (await req("GET", "/", { Cookie: COOKIE })).code);
check("an RPC on the cookie alone", 401,
  (await req("POST", "/api/settings.describe", { Cookie: COOKIE }, "{}")).code);

console.log("\n== the two event streams, from this deployment's own origin ==");
for (const ep of ["events.host", "events.mux"]) {
  check(`${ep} on the cookie`, 101, (await upgrade(`/api/${ep}`, { Cookie: COOKIE, Origin: SELF })).code);
  check(`${ep} on the password`, 101, (await upgrade(`/api/${ep}`, { Authorization: BASIC, Origin: SELF })).code);
  check(`${ep} with no Origin at all`, 101, (await upgrade(`/api/${ep}`, { Cookie: COOKIE })).code);
  check(`${ep} with no credential`, 401, (await upgrade(`/api/${ep}`, { Origin: SELF })).code);
  check(`${ep} on a forged cookie`, 401, (await upgrade(`/api/${ep}`, { Cookie: FORGED, Origin: SELF })).code);
}

// Not scoped to the two event paths on purpose: what refuses the cookie elsewhere is upstream,
// which has nothing to upgrade on any other path, so the gate does not name paths it would then
// have to track across an upstream rename.
console.log("\n== the cookie is not path-scoped, and upstream is what makes that fine ==");
checkNot("an upgrade off the event paths passes the gate", 401,
  (await upgrade("/", { Cookie: COOKIE, Origin: SELF })).code);
check("the same upgrade with no credential", 401, (await upgrade("/", { Origin: SELF })).code);

console.log("\n== a handshake from any other origin is refused before auth ==");
for (const [name, origin] of [
  ["a sibling deployment", FOREIGN],
  ["a host-prefix lookalike", `https://${HOST}.example.com`],
  ["this host on another port", `http://${HOST}:3000`],
  ["this host on the other scheme", OTHER_SCHEME],
  ["an opaque origin", "null"],
]) {
  check(`${name}, on the cookie`, 403, (await upgrade("/api/events.host", { Cookie: COOKIE, Origin: origin })).code);
  check(`${name}, on the password`, 403, (await upgrade("/api/events.host", { Authorization: BASIC, Origin: origin })).code);
}
check("a mixed-case Upgrade header too", 403,
  (await upgrade("/api/events.host", { Cookie: COOKIE, Origin: FOREIGN }, "WebSocket")).code);

console.log("\n== CSRF: a state change is judged on Origin, not on Sec-Fetch-Site ==");
check("cross-origin POST, no Sec-Fetch-Site", 403,
  (await rpc("settings.describe", {}, { Origin: FOREIGN })).code);
check("cross-origin POST claiming same-site", 403,
  (await rpc("settings.describe", {}, { Origin: FOREIGN, "Sec-Fetch-Site": "same-site" })).code);
check("cross-origin POST claiming cross-site", 403,
  (await rpc("settings.describe", {}, { Origin: FOREIGN, "Sec-Fetch-Site": "cross-site" })).code);
check("cross-scheme POST", 403, (await rpc("settings.describe", {}, { Origin: OTHER_SCHEME })).code);
check("same-origin POST", 200, (await rpc("settings.describe", {}, { Origin: SELF })).code);
check("POST with no Origin (curl, this script)", 200, (await rpc("settings.describe")).code);
check("a cross-origin GET is only auth-gated", 200,
  (await req("GET", "/", { Authorization: BASIC, Origin: FOREIGN })).code);

console.log("\n== the privileged plane, through the Host and Origin rewrite ==");
for (const [method, payload] of [
  ["settings.describe", {}],
  ["credentials.describe", { refs: [] }],
  ["llm.providers", {}],
  ["llm.models", {}],
]) {
  const r = await rpc(method, payload, { Origin: SELF });
  check(`${method} answers ok`, true, r.text.includes('"ok":true'));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
