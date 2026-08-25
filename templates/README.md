# Template registry

One deployable app per folder: a manifest, an optional Dockerfile, a detail page, and a logo.
Templates published from here appear in the InstaCloud gallery and deploy with a single command.

**Contributions are welcome.** Adding a template is one pull request against this repo: no separate
asset PR, no coordination with any other repository. Read [AGENTS.md](AGENTS.md) for the rules CI
enforces, then copy the closest existing template as a starting point. General contribution setup
lives in the repo's [CONTRIBUTING.md](../CONTRIBUTING.md).

## Structure

```
templates/<code>/
  insta.template.yaml    # the manifest (source of truth); the folder name IS the code
  Dockerfile             # only when the template builds an overlay image. Wired by
                         # convention: templates-build-images.yml builds the folder and
                         # pushes the image the manifest then references as image:.
                         # Never a manifest build: key
  README.md              # the detail page (see AGENTS.md for the section order)
  logo.svg               # the template's mark; required for a publishable template.
                         # logo.png when upstream has no vector mark; meta.logo: none
                         # when it has no mark at all
scripts/
  lint.mjs               # the rules CI enforces (npm run lint)
  version-guard.mjs      # a changed template must bump its version (npm run version-guard)
  publish.mjs            # registry -> hosted catalog sync, run by CI on merge
  deploy.mjs             # local executor for trying a template by hand
```

A service may declare `spec: <name>` (for example `1vcpu-1gb`) to be created at that compute size
instead of the platform default, and `volume: { size: N }` for a persistent disk mounted at
`/data`. See [AGENTS.md](AGENTS.md) for the field rules.

## Logo attribution

Each mark belongs to its upstream project and is committed here, so contributing a template stays a
single pull request. Transparency below is measured from corner-pixel alpha rather than colour type,
because an RGBA file can still be fully opaque.

| Template | File | Transparent | Dark mode | Source |
|---|---|---|---|---|
| `claude-code` | `logo.svg` 2.5 KB | yes (vector) | fixed `#D97757` | Anthropic's Claude Code mark |
| `codex` | `logo.svg` 3.7 KB | yes (vector) | fixed (blue gradient, white glyph) | OpenAI's Codex mark |
| `pi` | `logo.svg` 618 B | yes (vector) | **adapts** via `prefers-color-scheme` | <https://pi.dev/logo-auto.svg> |
| `hermes` | `logo.png` 512x512 | yes (corner alpha 0) | fixed light plate | Upstream's own app icon, `apps/desktop/assets/icon.png` at 1024x1024, downscaled. This row used to name the NousResearch GitHub org avatar and claim upstream published no transparent mark; that icon disproves it. No vector option: upstream's only SVG is a bare `⚕` glyph in the default font, which the rules below reject. Stored greyscale+alpha, halving the bytes for a max difference of 3/255 on a single pixel. The white plate is part of the artwork, not a background: the character's face is the plate showing through, so cutting it out would erase the face |
| `n8n` | `logo.svg` 1.6 KB | yes (vector) | fixed `#EA4B71` | n8n's brand mark |
| `openclaw` | `logo.svg` 4.6 KB | yes (vector) | fixed; includes a near-black `#050810` element | OpenClaw's mark |
| `9router` | `logo.png` 500x500 | yes (corner alpha 0) | fixed orange `#F34E21` | 9router's own mark, taken from the copy at `i.imgur.com/yjb5HvR.png`. Upstream's repo PNG (`images/9router.png`) is a 2940x2594 screenshot of the app, not this mark, so that copy is the only place the asset is available. Please do not "correct" this row to the repo URL |

Logos are served to the gallery from jsDelivr, pinned to the commit that published the template:
`https://cdn.jsdelivr.net/gh/InsForge/insta-oss@<sha>/templates/<code>/logo.svg`. That URL is
immutable per published version and cached at the edge, so a gallery loading eight of them costs
nothing.

## Try a template locally

```bash
npm install
INSTA_LINK_DIR=<a dir linked to your project> npm run deploy -- claude-code --branch my-branch
# pass variables with --set KEY=value. Anything you omit resolves the way the
# platform resolves it: a declared generator mints a value, otherwise the
# manifest's default applies, and only a variable with neither stops the run.
# The summary at the end names every value you did not supply yourself.
```

`deploy.mjs` drives the standard `insta` CLI end to end: create services, run generators, write
variables (including the `template@version` attribution stamp), deploy, poll until healthy, print
the URLs. It is a convenience for authoring and debugging a template by hand; the hosted platform
runs the same steps server-side.

## Rules

See [AGENTS.md](AGENTS.md). CI runs `npm run lint` and the version guard on every pull request.
