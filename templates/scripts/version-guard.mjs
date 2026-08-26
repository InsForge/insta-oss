#!/usr/bin/env node
// Version-bump guard. A changed publishable template MUST bump its manifest `version`: the image
// workflow pushes the canonical ghcr :<version> tag from that field on every main build, so an
// edit without a bump silently overwrites an already-published image: restart drift for
// instances already deployed. Drafts are exempt (they publish nothing).
// Usage: version-guard.mjs <base-ref>
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const base = process.argv[2];
if (!base) fail("usage: version-guard.mjs <base-ref>");

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // templates/
let repoRoot; // set by the first git() call, which therefore runs in process.cwd()
repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
const prefix = relative(repoRoot, root); // e.g. "templates"

// An unresolvable base (first push, force-push, shallow clone) leaves nothing to compare against.
try { git(["cat-file", "-e", `${base}^{commit}`]); }
catch { console.log(`~ base ref '${base}' not available: version-bump guard skipped`); process.exit(0); }

const changed = git(["diff", "--name-only", base, "--", prefix]).split("\n").filter(Boolean);

// code -> the paths that changed under it, relative to the template directory.
const byCode = new Map();
for (const p of changed) {
  const seg = relative(prefix, p).split("/");
  if (seg.length < 2 || seg[0] === "scripts") continue;
  const code = seg[0];
  if (!byCode.has(code)) byCode.set(code, []);
  byCode.get(code).push(seg.slice(1).join("/"));
}
const codes = [...byCode.keys()].sort();

// The bump exists to stop a rebuild overwriting a published image tag, so it is owed only by a
// change the image or the manifest can see. README.md is neither: no Dockerfile copies it, and the
// catalog takes it from `readme` on every publish, upserted by code, so it reaches users without a
// version moving. Requiring a bump for a typo fix also cost every running instance an
// "update available" marker pointing at an identical image.
const DOC_ONLY = new Set(["README.md"]);
const isDocOnly = (code) => byCode.get(code).every((p) => DOC_ONLY.has(p));

let failures = 0;
for (const code of codes) {
  const file = join(root, code, "insta.template.yaml");
  if (!existsSync(file)) { console.log(`~ ${code}: no manifest in the working tree (deleted): skipped`); continue; }
  const m = yaml.load(readFileSync(file, "utf8"));
  if (m?.meta?.draft === true) { console.log(`~ ${code}: draft: bump not required`); continue; }
  if (isDocOnly(code)) { console.log(`~ ${code}: documentation only: bump not required`); continue; }

  let baseManifest;
  try { baseManifest = yaml.load(git(["show", `${base}:${prefix}/${code}/insta.template.yaml`])); }
  catch { console.log(`✓ ${code}: new template at ${String(m?.version)}`); continue; }

  if (String(baseManifest?.version) === String(m?.version)) {
    failures++;
    console.error(`✗ ${code}: changed without a version bump: still ${String(m?.version)}. Bump it: the canonical ghcr tag ghcr.io/insforge/insta-oss/templates/${code}:${String(m?.version)} is already published and would be overwritten, drifting instances already deployed.`);
  } else {
    console.log(`✓ ${code}: ${String(baseManifest?.version)} -> ${String(m?.version)}`);
  }
}
if (!codes.length) console.log("no template directories changed");
process.exit(failures ? 1 : 0);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", cwd: repoRoot ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
}
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }
