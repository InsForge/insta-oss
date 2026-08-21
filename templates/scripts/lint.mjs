#!/usr/bin/env node
// Registry lint: the four rules from the design doc, enforced in CI.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// Template dirs live beside this script's parent (templates/<code>/): runs from any cwd.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NON_TEMPLATE = new Set(["scripts", "node_modules"]);
let failures = 0;
const codes = new Set();

// rule 4: index.json is CI-generated: a committed copy is rejected (AGENTS.md)
if (existsSync(join(root, "index.json"))) { failures++; console.error("✗ index.json: never commit it: CI generates it"); }

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const dirs = readdirSync(root).filter((d) => !NON_TEMPLATE.has(d) && statSync(join(root, d)).isDirectory());
for (const dir of dirs) {
  const before = failures;
  const file = join(root, dir, "insta.template.yaml");
  if (!existsSync(file)) { err(dir, "missing insta.template.yaml"); continue; }
  let m;
  try { m = yaml.load(readFileSync(file, "utf8")); } catch (e) { err(dir, `yaml parse: ${e.message}`); continue; }
  const draft = m?.meta?.draft === true;

  // rule 3: mandatory fields (version must be semver)
  for (const f of ["code", "version", "maintainer"]) if (!m?.[f]) err(dir, `missing ${f}`);
  if (m?.version && !SEMVER_RE.test(String(m.version))) err(dir, `version '${m.version}' is not semver`);
  if (!m?.meta?.category) err(dir, "missing meta.category");
  if (!m?.upstream?.pinned) err(dir, "missing upstream.pinned");
  if (m?.code && m.code !== dir) err(dir, `code '${m.code}' != folder name`);
  if (m?.code) { if (codes.has(m.code)) err(dir, "duplicate code"); codes.add(m.code); }

  // Every publishable template ships its own logo, so a contributed template needs one PR, not two.
  // `meta.logo: none` is the explicit opt-out for an upstream with no mark (consumers show a
  // monogram): a declaration that gets reviewed, unlike a silently missing file.
  if (!draft && m?.meta?.logo !== "none" && !["logo.svg", "logo.png"].some((f) => existsSync(join(root, dir, f)))) {
    err(dir, "missing logo.svg (or logo.png): add one, or declare meta.logo: none if upstream has no mark");
  }
  // A declared path must resolve, so the catalog can never publish a reference to a missing file
  const logoRef = m?.meta?.logo;
  if (logoRef && logoRef !== "none" && !existsSync(join(root, dir, String(logoRef).replace(/^\.\//, "")))) {
    err(dir, `meta.logo points at ${logoRef}, which does not exist`);
  }

  const declared = new Set();
  for (const [name, svc] of Object.entries(m?.services ?? {})) {
    for (const group of ["required", "optional"]) for (const k of Object.keys(svc.env?.[group] ?? {})) declared.add(k);
    if (svc.type === "postgres") continue; // managed service: platform injects credentials
    // rule 1: image must be pinned (tag or digest), never latest/tagless
    if (!svc.image && !svc.build) err(dir, `${name}: needs image or build`);
    // the platform parser refuses both (image is what deploys; the Dockerfile is wired by convention)
    if (svc.image && svc.build) err(dir, `${name}: image and build are mutually exclusive: drop build:, keep image:`);
    if (svc.image && !draft) {
      const ref = String(svc.image);
      if (!/[@:]/.test(ref.split("/").pop()) || /:latest$/.test(ref)) err(dir, `${name}: image must pin a tag or digest (got '${ref}')`);
    }
    if (svc.build && !existsSync(join(root, dir, svc.build.replace(/^\.\//, "")))) err(dir, `${name}: build file ${svc.build} not found`);
    if (svc.type === "web" && !svc.healthcheck) err(dir, `${name}: web service needs healthcheck`);
    // rule 2: required vars need description (unless generated)
    for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
      if (!spec?.generate && !spec?.description) err(dir, `required var ${k} needs a description`);
    }
    // generated refs must be declared
    for (const [k, ref] of Object.entries(svc.env?.generated ?? {})) {
      const key = String(ref).replace(/^\$\{(.+)\}$/, "$1");
      if (!(m.generated ?? {})[key]) err(dir, `env.generated.${k} references undeclared '${key}'`);
    }
  }
  // constraints may only name declared required/optional variables (platform parser rule)
  (m?.constraints ?? []).forEach((c, i) => {
    for (const kind of ["oneOf", "allOf"]) {
      if (c?.[kind] === undefined) continue;
      if (!Array.isArray(c[kind])) { err(dir, `constraints[${i}].${kind} must be an array of variable names`); continue; }
      for (const n of c[kind]) if (!declared.has(n)) err(dir, `constraints[${i}].${kind} references undeclared variable '${n}'`);
    }
    if (!c?.oneOf && !c?.allOf) err(dir, `constraints[${i}] must carry oneOf or allOf`);
  });
  if (failures > before) continue; // already reported ✗ for this template: no misleading ✓ after it
  if (draft) console.log(`~ ${dir}: draft (index-excluded), relaxed checks`);
  else console.log(`✓ ${dir}`);
}

function err(dir, msg) { failures++; console.error(`✗ ${dir}: ${msg}`); }
process.exit(failures ? 1 : 0);
