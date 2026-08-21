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
const codes = [...new Set(
  changed
    .map((p) => relative(prefix, p).split("/"))
    .filter((seg) => seg.length > 1 && seg[0] !== "scripts")
    .map((seg) => seg[0]),
)].sort();

let failures = 0;
for (const code of codes) {
  const file = join(root, code, "insta.template.yaml");
  if (!existsSync(file)) { console.log(`~ ${code}: no manifest in the working tree (deleted): skipped`); continue; }
  const m = yaml.load(readFileSync(file, "utf8"));
  if (m?.meta?.draft === true) { console.log(`~ ${code}: draft: bump not required`); continue; }

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
