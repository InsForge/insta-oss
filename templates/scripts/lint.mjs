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
// Mirror of the platform's compute catalog. The platform is the authority; this copy exists so a
// typo fails on the pull request instead of on the publish run after merge.
const COMPUTE_SPECS = ["1vcpu-256mb", "1vcpu-512mb", "1vcpu-1gb", "2vcpu-1gb", "2vcpu-2gb"];
// Images this repo builds for itself; templates-build-images derives their tag from `version:`.
const SELF_IMAGE_PREFIX = "ghcr.io/insforge/insta-oss/templates/";
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

  // README images: publish.mjs rewrites relative targets into absolute CDN URLs pinned to the
  // commit, so a missing or escaping asset would only surface as a broken image on the gallery.
  // Catch it here instead.
  const readme = join(root, dir, "README.md");
  if (existsSync(readme)) {
    const text = readFileSync(readme, "utf8");
    const targets = [
      ...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g),
      ...text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi),
    ].map((mt) => mt[1]);
    for (const t of targets) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(t)) continue; // absolute, left alone at publish
      const rel = t.replace(/^\.\//, "").split(/[?#]/)[0];
      if (!rel) continue;
      if (rel.split("/").includes("..")) {
        err(dir, `README image '${t}' points outside the template directory; keep assets beside the manifest`);
      } else if (!existsSync(join(root, dir, rel))) {
        err(dir, `README image '${t}' does not exist in the template directory`);
      }
    }
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
      // An image we build ourselves is tagged from `version:` by templates-build-images, while
      // this line is typed by hand. Drift means publishing a manifest that points at a tag no
      // build ever pushed, which surfaces as publish.mjs polling for ten minutes and failing, or
      // worse as a deploy pulling a stale version that does exist.
      const self = ref.startsWith(SELF_IMAGE_PREFIX) ? ref.slice(SELF_IMAGE_PREFIX.length) : null;
      if (self && !self.includes("@")) {
        const [imageCode, tag] = [self.split(":")[0], self.split(":")[1]];
        if (imageCode !== dir) err(dir, `${name}: image is ${SELF_IMAGE_PREFIX}${imageCode}, which is another template's`);
        else if (tag !== String(m.version)) err(dir, `${name}: image tag '${tag}' != version '${m.version}': the build tags from version:, so nothing would push '${tag}'`);
      }
    }
    if (svc.build && !existsSync(join(root, dir, svc.build.replace(/^\.\//, "")))) err(dir, `${name}: build file ${svc.build} not found`);
    if (svc.type === "web" && !svc.healthcheck) err(dir, `${name}: web service needs healthcheck`);
    if (svc.spec !== undefined && !COMPUTE_SPECS.includes(String(svc.spec))) {
      err(dir, `${name}: unknown compute spec '${svc.spec}' (one of: ${COMPUTE_SPECS.join(", ")})`);
    }
    // Same message the platform uses. Catches the shape only: a misspelled key is silent on both sides.
    if (svc.alwaysOn !== undefined && typeof svc.alwaysOn !== "boolean") {
      err(dir, `${name}: alwaysOn must be a boolean`);
    }
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
