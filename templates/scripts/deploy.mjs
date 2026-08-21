#!/usr/bin/env node
// Prototype executor: insta.template.yaml -> existing insta CLI pipeline.
// Steps (per design doc): parse manifest -> create services -> run generators
// -> resolve cross-service refs -> write variables -> deploy (stamp
// template@version attribution) -> poll healthy -> report URL.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? ".");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const branch = flag("--branch");
const sets = Object.fromEntries(
  args.flatMap((a, i) => (a === "--set" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])),
);
// Values that must never reach stdout/stderr: caller-supplied --set inputs and everything a
// generator mints. Manifest `fixed` values are public (they live in the repo) and stay readable.
// Declared before the first fail(): every print path runs through redact().
const secretValues = new Set(Object.values(sets).filter(Boolean));
if (!branch) fail("usage: deploy.mjs <template-dir> --branch <b> [--set K=V ...]");

// [1/8] parse manifest
const manifest = yaml.load(readFileSync(join(dir, "insta.template.yaml"), "utf8"));
const services = Object.entries(manifest.services ?? {});
if (!services.length) fail("manifest has no services");
step(1, `parsed ${manifest.code}@${manifest.version}: ${services.length} service(s)`);

// [2/8] run generators (declare-once, reference-many: Dokploy style)
const generated = {};
for (const [name, spec] of Object.entries(manifest.generated ?? {})) {
  generated[name] = genValue(spec);
}
step(2, `generated ${Object.keys(generated).length} value(s)`);

// [3/8] create services
for (const [name, svc] of services) {
  const cmd = ["services", "add", "compute", name, "--branch", branch, "--port", String(svc.port ?? 8080)];
  if (svc.volume?.size) cmd.push("--volume", String(svc.volume.size));
  if (svc.image) cmd.push("--image", svc.image);
  try {
    insta(cmd);
  } catch (e) {
    if (!String(e.stderr ?? e).includes("already exists")) throw e;
    log(`   service ${name} already exists: idempotent, continuing`);
  }
}
step(3, "services created");

// [4/8] resolve cross-service refs (all services now have addresses)
// prototype: internal hostnames not yet exposed by platform: placeholder pass.
step(4, "cross-service refs resolved (none declared)");

// [5/8] assemble + write variables
const deploymentId = randomUUID();
for (const [name, svc] of services) {
  const env = { ...(svc.env?.fixed ?? {}) };
  for (const [k, ref] of Object.entries(svc.env?.generated ?? {})) {
    const key = String(ref).replace(/^\$\{(.+)\}$/, "$1");
    if (!(key in generated)) fail(`env.generated.${k} references undeclared generator '${key}'`);
    env[k] = generated[key];
  }
  for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
    if (sets[k]) env[k] = sets[k];
    else if (spec?.generate) env[k] = genValue(spec.generate);
    else fail(`required variable ${k} missing: pass --set ${k}=...  (${spec?.description ?? ""})`);
  }
  for (const k of Object.keys(svc.env?.optional ?? {})) if (sets[k]) env[k] = sets[k];
  // attribution stamp (design doc: template@version + deployment_id, recorded
  // on the service; platform field pending: prototype stamps via env)
  env.TEMPLATE_CODE = manifest.code;
  env.TEMPLATE_VERSION = manifest.version;
  env.TEMPLATE_DEPLOYMENT_ID = deploymentId;
  for (const [k, v] of Object.entries(env)) insta(["secrets", "set", k, String(v), "--branch", branch]);
  log(`   ${name}: wrote ${Object.keys(env).length} variables (incl. attribution stamp)`);
}
step(5, `variables written: deployment_id ${deploymentId}`);

// [6/8] deploy (build path when Dockerfile declared, else image pull)
const urls = {};
for (const [name, svc] of services) {
  // build-type: insta deploy <dir> ... (remote build); image-type: insta deploy ... --image <ref>
  const cmd = ["deploy", ...(svc.build ? [dir] : []), "--branch", branch, "--group", name, "--port", String(svc.port ?? 8080)];
  if (!svc.build) cmd.push("--image", svc.image);
  const out = insta(cmd);
  const m = out.match(/->\s+(https:\/\/\S+)/);
  urls[name] = m?.[1];
}
step(6, "deployed");

// [7/8] poll until healthy (auth-gated services answer 401: that counts)
for (const [name, svc] of services) {
  const url = urls[name];
  if (!url) fail(`no URL captured for ${name}`);
  const deadline = Date.now() + 180_000;
  let status = 0;
  while (Date.now() < deadline) {
    try {
      status = (await fetch(url + (svc.healthcheck ?? "/"), { method: "GET" })).status;
      if (status > 0 && status < 500) break;
    } catch { /* cold start */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!(status > 0 && status < 500)) fail(`${name} not healthy within 180s (last status ${status})`);
  log(`   ${name}: healthy (HTTP ${status})`);
}
step(7, "health checks passed");

// [8/8] report
step(8, "done\n");
for (const [name] of services) log(`  ${name}: ${urls[name]}`);
const pw = Object.entries(services[0][1].env?.required ?? {}).find(([, s]) => s?.generate);
if (pw && !sets[pw[0]]) log(`  ${pw[0]} (generated, shown once): see secrets store: insta run --branch ${branch} -- printenv ${pw[0]}`);
log(`  attribution: ${manifest.code}@${manifest.version}  deployment ${deploymentId}`);

// helpers
// Replace every known secret value with ***: the backstop for anything that reaches a stream.
function redact(text) {
  let out = String(text);
  for (const v of secretValues) if (v && v.length >= 4) out = out.split(v).join("***");
  return out;
}
// `secrets set KEY VALUE` echoes as `secrets set KEY=***`: the key is the useful half.
function displayArgs(cmdArgs) {
  const shown = cmdArgs[0] === "secrets" && cmdArgs[1] === "set" && cmdArgs.length > 3
    ? ["secrets", "set", `${cmdArgs[2]}=***`, ...cmdArgs.slice(4)]
    : cmdArgs;
  return shown.map((a) => {
    const safe = redact(a);
    return safe.length > 60 ? safe.slice(0, 57) + "..." : safe;
  });
}
function insta(cmdArgs) {
  log(`   $ insta ${displayArgs(cmdArgs).join(" ")}`);
  try {
    return execFileSync("insta", cmdArgs, {
      encoding: "utf8",
      cwd: process.env.INSTA_LINK_DIR ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // execFileSync stamps the whole command line: values included: into message/stderr/stdout.
    // Scrub before the error escapes to a handler, a rethrow, or an unhandled stack trace.
    e.message = redact(e.message);
    if (e.stderr) e.stderr = redact(e.stderr);
    if (e.stdout) e.stdout = redact(e.stdout);
    throw e;
  }
}
function genValue(spec) {
  const m = String(spec).match(/^secret:(\d+)$/);
  if (!m) fail(`unknown generator '${spec}'`);
  const value = randomBytes(Number(m[1])).toString("base64url").slice(0, Number(m[1]));
  secretValues.add(value);
  return value;
}
function step(n, msg) { console.log(redact(`[${n}/8] ${msg}`)); }
function log(msg) { console.log(redact(msg)); }
function fail(msg) { console.error(redact(`error: ${msg}`)); process.exit(1); }
