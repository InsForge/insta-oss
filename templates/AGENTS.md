# Contributing a template

For humans and agents alike. One template per folder under `templates/<code>/`, and the folder name
IS the template code. Copying the closest existing template is the fastest way to start.

## Files

- `insta.template.yaml`: the manifest, and the source of truth. Required.
- `Dockerfile`: only when the template builds an overlay image. The workspace templates
  (`claude-code`, `codex`, `pi`) do; a template that references an official upstream image, like
  `n8n`, must not rebuild it. It is wired **by convention**: `templates-build-images.yml` builds
  `templates/<code>/` and pushes `ghcr.io/insforge/insta-oss/templates/<code>:<version>`, which the
  manifest then references as `image:`. Never add a `build:` key to the manifest. The catalog
  rejects a service carrying both `image:` and `build:`, and `image:` is the one that deploys.
- `README.md`: the detail page shown in the gallery. Required, and factual: leave a fact out rather
  than guess it. Follow the section order the existing templates use, which is Overview, what you
  get by hosting it, what you need before deploying, Configuration (a row per variable saying what
  it does and where the value comes from), After deploy (how to actually start using it), and
  Links (upstream, the image or package, the license). A draft template opens with a note saying
  why it is draft.
- `logo.svg`: the template's mark, and a **hard requirement for a publishable template**. CI
  rejects a non-draft template without one. Declare the path as `meta.logo: ./logo.svg` and CI
  checks that it resolves. Details and the reasoning are under [Logos](#logos).
- Screenshots and any other README assets: keep them in your own template directory and reference
  them with **relative** paths, such as `![](./screenshot.png)`. The README is published to the
  gallery as text, where a relative path would resolve against the gallery's own origin and 404, so
  the publish step rewrites relative targets into absolute URLs pinned to the publishing commit:
  images through the same CDN as the logo, and links to the GitHub page a reader can browse. Two
  rules follow, both enforced by CI: a referenced asset must exist, and an image may not point
  outside its own template directory, because nothing outside it is the template's to ship.

## Hard rules (CI rejects violations)

1. Image references pin a specific tag or digest. `latest` or tagless is rejected, because an
   image that floats on `latest` silently changes under a deployed instance on every restart.
2. Every required variable without a generator has a `description` saying what it is and where to
   get it.
3. `code`, `version` (semver), `maintainer`, `upstream.pinned` and `meta.category` are mandatory.
4. A changed template must bump its `version`. The canonical image tag is derived from it, so
   editing a template without bumping would overwrite an image that published instances pull.
5. A service may not carry both `image:` and `build:`.
6. `constraints[].oneOf` and `allOf` may only name variables the manifest declares.
7. `spec:` must name a compute size the platform offers (`1vcpu-256mb`, `1vcpu-512mb`, `1vcpu-1gb`,
   `2vcpu-1gb`, `2vcpu-2gb`). `npm run lint` mirrors that list; the platform is the authority.
8. Never commit `index.json`. CI generates it.

## Logos

A template directory owns everything about itself, so contributing one is a single pull request
here rather than a manifest PR plus an asset PR somewhere else. Prefer SVG. `logo.png` is fine when
upstream has no vector mark: keep it square, roughly 128 to 512 px, and under about 100 KB.

- Use the upstream project's **own** mark, never a redrawn one.
- Check the project's **product site**, not just its repository. A repo often carries only a banner
  or a README screenshot while the site serves a real mark. `pi.dev/logo-auto.svg` is where pi's
  came from, after its repository appeared to have none.
- A mark that adapts to dark mode is strictly better than one that does not, and worth asking for.
  pi's carries its own `@media (prefers-color-scheme: dark)` rule, so one file works on light and
  dark surfaces alike.
- Reject a `<text>`-based mark even when it is upstream's own favicon. A glyph in `system-ui`
  renders differently on every machine, and two of the upstreams here ship exactly that.
- The asset must have **real transparency**. Check the corner pixels' alpha rather than the colour
  type, because an RGBA file can still be fully opaque. A mark baked onto a solid background reads
  as a coloured tile and fights whichever theme it was not drawn for.
- Where upstream publishes nothing transparent, say so in the attribution table in
  [README.md](README.md) and let the card put a neutral tile behind it. Do not hand-cut one.
- If upstream has no mark at all, declare `meta.logo: none`. Consumers fall back to a monogram.
  That declaration gets reviewed; a missing file does not.

Why the file lives in the repo instead of a URL in the manifest: a gallery that lets an author name
any URL ends up pulling images from image hosts and personal CDNs, which rot silently, arrive in
unpredictable sizes, and send every visitor's browser to a third party. Keeping the file here means
the catalog holds only a reference, and it is served from a CDN pinned to the publishing commit.

## Conventions

- Volumes mount at `/data`, which the platform fixes. Point the app's data directory there with its
  own env var (`HERMES_HOME`, `N8N_USER_FOLDER`, `HOME`) and check upstream docs for the right one.
- Fair-code upstreams such as n8n: reference the official image, and never rebuild or rebrand it.
- A template that exposes a terminal MUST require an access credential (for ttyd, the `-c` flag).
- Categories are `ai-agent`, `llm` and `automation`. Propose a new one in your PR rather than
  reaching for `other`.
- `meta.draft: true` keeps a template out of the gallery while it is unfinished. Drafts are exempt
  from the logo and version-bump rules, because they publish nothing.
- Everything in this tree is **English**, comments included. A comment only some contributors can
  read is a comment that rots.
- User-facing strings are `meta.name`, `meta.tagline`, every variable `description`, and the README.
  They render in the public gallery and in the deploy form. Keep a tagline short: a noun phrase
  saying what the thing is, roughly 6 to 10 words, no trailing period, and never restating the
  template name that the card already shows.
- `upstream.license` carries the SPDX identifier of the software being packaged. Use the
  `LicenseRef-` form when it is not an OSS license, such as a vendor's commercial terms, and read
  the value off the upstream repository or package rather than assuming it.
- No em dashes in this repo, matching the rest of the docs.

## Flow

Open a pull request against `main`. CI runs the lint and the version guard; a reviewer merges; the
publish workflow syncs the change to the hosted catalog. Deployed instances never auto-update, so
bumping `version` is what surfaces an "update available" marker to someone already running it.
