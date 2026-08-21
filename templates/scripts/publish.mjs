#!/usr/bin/env node
// Publish manifests to the platform registry: PUT /admin/templates/:code (staff bearer, upsert).
// Auth: login-per-run via INSTA_BOT_EMAIL/INSTA_BOT_PASSWORD (preferred: sessions expire when
// idle), else a static INSTA_PLATFORM_STAFF_TOKEN. INSTA_PLATFORM_URL is always required.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import yaml from "js-yaml";

const url = process.env.INSTA_PLATFORM_URL?.replace(/\/+$/, "");
if (!url) fail("INSTA_PLATFORM_URL must be set");
const dirs = process.argv.slice(2);
if (!dirs.length) fail("usage: publish.mjs <template-dir> [<template-dir> ...]");
const token = await staffToken();

// Ghcr gate polling knobs: templates-build-images runs on the same push, so the canonical
// tag usually lands a minute or two after publish starts.
const GHCR_ATTEMPTS = Number(process.env.GHCR_CHECK_ATTEMPTS ?? 15);
const GHCR_DELAY_MS = Number(process.env.GHCR_CHECK_DELAY_MS ?? 40_000);

// Mint a fresh session when bot credentials exist; fall back to a static token.
async function staffToken() {
  const { INSTA_BOT_EMAIL: email, INSTA_BOT_PASSWORD: password, INSTA_PLATFORM_STAFF_TOKEN: staticToken } = process.env;
  if (email && password) {
    const res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) fail(`bot login failed with HTTP ${res.status}. ${(await res.text()).slice(0, 300)}`);
    console.log("logged in via bot credentials");
    return (await res.json()).accessToken;
  }
  if (staticToken) return staticToken;
  return fail("set INSTA_BOT_EMAIL + INSTA_BOT_PASSWORD (preferred) or INSTA_PLATFORM_STAFF_TOKEN");
}

let failures = 0;
for (const dir of dirs) {
  const code = basename(dir.replace(/\/+$/, ""));
  const text = readFileSync(join(dir, "insta.template.yaml"), "utf8");
  const m = yaml.load(text);
  if (m?.meta?.draft === true) { console.log(`~ ${code}: draft, skipped`); continue; }
  if (m?.code !== code) { failures++; console.error(`✗ ${code}: manifest code '${m?.code}' != folder name`); continue; }
  // Never publish a manifest whose ghcr image doesn't exist yet (merge can outrun the build).
  try { await assertGhcrImages(m); }
  catch (e) { failures++; console.error(`✗ ${code}: ${e.message}`); continue; }
  // Body: manifest is the raw YAML text (the catalog parses and normalizes it), plus the two
  // things a manifest cannot carry itself. readme is a file, and logoUrl has to be absolute
  // because a relative ./logo.svg means nothing to the catalog. Unknown fields are ignored by
  // older catalog versions, so sending them is safe before the receiving side ships.
  let body;
  try { body = JSON.stringify({ manifest: text, readme: readmeOf(dir), logoUrl: logoUrlOf(dir, m) }); }
  catch (e) { failures++; console.error(`✗ ${code}: ${e.message}`); continue; }
  const res = await fetch(`${url}/admin/templates/${code}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  if (res.ok) { console.log(`✓ ${code}: published ${m.code}@${m.version}`); }
  else { failures++; console.error(`✗ ${code}: HTTP ${res.status}. ${(await res.text()).slice(0, 500)}`); }
}
process.exit(failures ? 1 : 0);

function readmeOf(dir) {
  const p = join(dir, "README.md");
  if (!existsSync(p)) return undefined;
  return absolutizeReadme(readFileSync(p, "utf8"), dir);
}

// A README is authored for GitHub, where `![](./shot.png)` resolves against the repo. The catalog
// serves the same text on another origin, where that path would resolve against THAT site and 404.
// So every relative target becomes absolute here, pinned to the publishing commit: images through
// the same jsDelivr CDN as the logo, links to the GitHub page a reader can actually browse.
function absolutizeReadme(text, dir) {
  const repo = process.env.GITHUB_REPOSITORY ?? "InsForge/insta-oss";
  const sha = process.env.GITHUB_SHA ?? gitHead();
  if (!sha) return text; // no commit to pin to: publish the text unchanged rather than guess
  const cdn = (p) => `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${p}`;
  const blob = (p) => `https://github.com/${repo}/blob/${sha}/${p}`;
  // Everything is computed in repo-relative terms, so this works whether the caller passed
  // `templates/hermes` or an absolute path.
  const dirInRepo = relative(repoRoot(), resolvePath(dir)).split(sep).join("/");

  const resolve = (target, isImage) => {
    // Absolute, protocol-relative, root-relative, anchor-only and mail targets are left alone.
    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) return null;
    const [, path, suffix = ""] = /^([^?#]*)([?#].*)?$/.exec(target);
    if (!path) return null;
    const stack = dirInRepo ? dirInRepo.split("/") : [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!stack.length) throw new Error(`README target '${target}' escapes the repository`);
        stack.pop();
      } else stack.push(part);
    }
    const resolved = stack.join("/");
    // An image must live in its own template directory: nothing outside it is the template's to ship.
    if (isImage && !resolved.startsWith(`${dirInRepo}/`)) {
      throw new Error(`README image '${target}' points outside the template directory; keep assets in ${dirInRepo}/`);
    }
    return (isImage ? cdn(resolved) : blob(resolved)) + suffix;
  };

  let out = text;
  // Markdown images, then markdown links (the negative lookbehind keeps images out of the link pass).
  out = out.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (m, head, target) => head + (resolve(target, true) ?? target));
  out = out.replace(/(^|[^!])(\[[^\]]*\]\()([^)\s]+)/g, (m, pre, head, target) => pre + head + (resolve(target, false) ?? target));
  // Inline HTML images.
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (m, head, q, target) => head + q + (resolve(target, true) ?? target) + q);
  return out;
}

// The logo is served from jsDelivr's CDN, pinned to the commit being published: immutable for
// that version, cached at the edge, and no anonymous GitHub rate limit on a gallery that loads
// several logos per view. Requires the repo to be public, which is why the registry lives here.
// GITHUB_SHA on a push to main is the merge commit; locally it falls back to the checked-out HEAD.
function logoUrlOf(dir, m) {
  const declared = m?.meta?.logo;
  if (!declared || declared === "none") return undefined;
  const file = String(declared).replace(/^\.\//, "");
  if (!existsSync(join(dir, file))) return undefined;
  const repo = process.env.GITHUB_REPOSITORY ?? "InsForge/insta-oss";
  const sha = process.env.GITHUB_SHA ?? gitHead();
  if (!sha) return undefined;
  return `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${dir.replace(/^\.\//, "")}/${file}`;
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return undefined; }
}

function repoRoot() {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); }
  catch { return process.cwd(); }
}

// Gate: every ghcr image the manifest references must exist before the PUT.
async function assertGhcrImages(m) {
  for (const [name, svc] of Object.entries(m.services ?? {})) {
    const ref = String(svc?.image ?? "");
    if (!ref.startsWith("ghcr.io/")) continue;
    const path = ref.slice("ghcr.io/".length);
    const cut = path.includes("@") ? path.indexOf("@") : (path.lastIndexOf(":") > path.lastIndexOf("/") ? path.lastIndexOf(":") : -1);
    const repo = cut >= 0 ? path.slice(0, cut) : path;
    const tag = cut >= 0 ? path.slice(cut + 1) : "latest";
    // `repo` keeps its slashes: ghcr's API is /v2/<owner>/<name>/manifests/<tag> and <name> may
    // itself be multi-segment (insta-oss/templates/<code>).
    const status = await ghcrTagStatus(repo, tag);
    if (status !== 0) {
      const why = status === 401 || status === 403
        ? `HTTP ${status}: the package is PRIVATE or the token lacks read:packages. Make the ghcr package public (org → Packages → Package settings → Change visibility), or check the workflow's packages: read + GHCR_TOKEN`
        // ghcr answers 404 (not 403) for a package the caller may not see, so a persistent 404 is
        // either "not built yet" or "private and this token cannot read it": name both.
        : `HTTP ${status}: either not published yet (wait for templates-build-images, then rerun publish via workflow_dispatch, which upserts), or the package exists but is not visible to this token: check that the ghcr package is public (org → Packages → Package settings → Change visibility) and that GHCR_TOKEN carries read:packages`;
      throw new Error(`services.${name}: ${ref} did not resolve on ghcr (${why})`);
    }
  }
}

// 0 when the tag resolves, else the last HTTP status seen. Polling exists for publish propagation
// (404 while the build finishes); 401/403 is a credentials/visibility verdict that will not
// self-heal, so it returns at once instead of burning the whole retry budget.
async function ghcrTagStatus(repo, tag) {
  let last = 0;
  for (let i = 1; i <= GHCR_ATTEMPTS; i++) {
    const token = await ghcrPullToken(repo);
    if (typeof token === "number") last = token; // the token endpoint itself refused
    else {
      const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json",
        },
      });
      if (res.ok) return 0;
      last = res.status;
    }
    if (last === 401 || last === 403) return last;
    if (i < GHCR_ATTEMPTS) {
      console.log(`  … ${repo}:${tag} not resolvable yet (HTTP ${last}): retry ${i}/${GHCR_ATTEMPTS - 1} in ${GHCR_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, GHCR_DELAY_MS));
    }
  }
  return last;
}

// The pull token, or the HTTP status when the token endpoint refuses, which is what a private
// package with no/insufficient credentials looks like. Anonymous suffices for public packages;
// GHCR_TOKEN (a GitHub token with read:packages) is needed for private ones.
async function ghcrPullToken(repo) {
  const headers = {};
  if (process.env.GHCR_TOKEN) headers.authorization = `Basic ${Buffer.from(`x-token:${process.env.GHCR_TOKEN}`).toString("base64")}`;
  const res = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`, { headers });
  if (!res.ok) return res.status;
  return (await res.json()).token;
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }
