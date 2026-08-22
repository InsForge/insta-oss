// Pure helpers for publish.mjs, kept separate so they can be tested without running the publisher
// (which talks to the catalog and calls process.exit).

/**
 * Split a `ghcr.io/<owner>/<name...>:<tag>` or `@<digest>` reference.
 * `name` may be multi-segment, and ghcr's API path keeps those slashes:
 * /v2/<owner>/<name>/manifests/<reference>.
 * Returns null for anything that is not a ghcr reference.
 */
export function parseGhcrRef(ref) {
  const s = String(ref ?? "");
  if (!s.startsWith("ghcr.io/")) return null;
  const path = s.slice("ghcr.io/".length);
  if (!path) return null;
  const at = path.indexOf("@");
  if (at >= 0) return { repo: path.slice(0, at), tag: path.slice(at + 1) };
  const colon = path.lastIndexOf(":");
  // A colon only introduces a tag when it comes after the last slash; otherwise it is part of a
  // host:port style prefix we do not expect here.
  if (colon > path.lastIndexOf("/")) return { repo: path.slice(0, colon), tag: path.slice(colon + 1) };
  return { repo: path, tag: "latest" };
}

/**
 * Whether an anonymous 401/403 from ghcr is worth waiting out.
 *
 * ghcr answers 403 to an ANONYMOUS caller both for a package that does not exist
 * yet and for one that exists but is private, so the status alone cannot tell
 * "the image build has not pushed it" from "someone has to flip visibility".
 * The authenticated probe separates them: 404 means it is not there, anything
 * that resolves means it is there and hidden.
 *
 * Getting this wrong is why every merge that bumped an image version failed and
 * needed a manual re-run: templates-build-images runs on the same push and takes
 * minutes, so publish always saw the anonymous 403 of a package still being
 * built, called it private, and gave up without using its retry budget.
 *
 * `retry` when there is no authenticated answer (no GHCR_TOKEN): the budget is
 * bounded, and failing a build that would have succeeded costs more than
 * spending it.
 *
 * @param {{anon: number, auth: number|null|undefined}} o
 * @returns {"retry"|"fatal"}
 */
export function ghcrRetryVerdict({ anon, auth }) {
  if (anon !== 401 && anon !== 403) return "retry";
  if (auth === null || auth === undefined) return "retry";
  return auth === 404 ? "retry" : "fatal";
}

/**
 * The failure message for an image that is not anonymously pullable.
 *
 * Anonymous is what matters: a template deploy pulls with no credentials. The authenticated probe
 * exists only to tell the two causes apart, because the fix differs.
 *
 * @param {object} o
 * @param {string} o.name  the service name
 * @param {string} o.ref   the image reference
 * @param {number} o.anon  HTTP status from the anonymous probe (never 0 here)
 * @param {number|null} o.auth  HTTP status from the authenticated probe, 0 when it succeeded,
 *                              or null when no GHCR_TOKEN was available to classify with
 */
export function ghcrGateMessage({ name, ref, anon, auth }) {
  if (auth === 0) {
    return `services.${name}: ${ref} exists but is NOT anonymously pullable (anonymous HTTP ${anon}, authenticated OK). ` +
      `Template deploys pull anonymously, so publishing this would register an image nobody can pull. ` +
      `Fix: set the ghcr package public (GitHub org → Packages → the package → Package settings → Change visibility), ` +
      `then re-run templates-publish via workflow_dispatch.`;
  }
  const authNote = auth === null
    ? "no GHCR_TOKEN was set, so this could not be told apart from a private package"
    : `authenticated HTTP ${auth}`;
  return `services.${name}: ${ref} did not resolve on ghcr (anonymous HTTP ${anon}, ${authNote}). ` +
    `Either the image is not published yet, so wait for templates-build-images and re-run ` +
    `templates-publish via workflow_dispatch (it upserts), or the package is private and needs ` +
    `its visibility changed.`;
}

/**
 * A README is authored for GitHub, where `![](./shot.png)` resolves against the repo. The catalog
 * serves the same text on another origin, where that path would resolve against THAT site and 404.
 * So every relative target becomes absolute, pinned to the publishing commit: images through the
 * same CDN as the logo, links to the GitHub page a reader can actually browse.
 *
 * @param {string} text            the README source
 * @param {object} opts
 * @param {string} opts.dirInRepo  the template directory, repo-relative (e.g. "templates/hermes")
 * @param {string} opts.repo       "<owner>/<repo>"
 * @param {string} opts.sha        the commit to pin to
 * @param {(p: string) => boolean} [opts.isDirectory]  does this repo-relative path name a directory
 * @throws when an image escapes its template directory, or any target escapes the repository
 */
export function rewriteReadme(text, { dirInRepo, repo, sha, isDirectory = () => false }) {
  const cdn = (p) => `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${p}`;
  // `blob` renders a file; a directory needs `tree`, or GitHub serves a broken URL.
  const page = (p, endsWithSlash) =>
    `https://github.com/${repo}/${endsWithSlash || isDirectory(p) ? "tree" : "blob"}/${sha}/${p}`;

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
    if (isImage) return cdn(resolved) + suffix;
    return page(resolved, path.endsWith("/")) + suffix;
  };

  let out = text;
  // Markdown images first, then markdown links (the leading [^!] keeps images out of the link pass).
  out = out.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (m, head, target) => head + (resolve(target, true) ?? target));
  out = out.replace(/(^|[^!])(\[[^\]]*\]\()([^)\s]+)/g, (m, pre, head, target) => pre + head + (resolve(target, false) ?? target));
  // Inline HTML images.
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (m, head, q, target) => head + q + (resolve(target, true) ?? target) + q);
  return out;
}
