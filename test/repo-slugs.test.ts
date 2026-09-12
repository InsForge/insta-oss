// The repo rename (insta-oss -> instacloud-oss, insta-cli -> instacloud-cli, insta-skills ->
// instacloud-skills) had to be swept by hand, and the sweep missed a leg: publish.mjs kept a
// hardcoded old slug as its GITHUB_REPOSITORY fallback, and nothing failed. A review's negative
// control then showed that reverting 28 of the 29 rewritten URLs left every gate green — tsc,
// eslint, the template linter, the version guard and the doc tests all passed on a fully
// sabotaged tree. Only the Dockerfile LABEL was bound, by test/image.int.test.ts.
//
// This test binds the other 28: any NEW old-slug URL fails here instead of shipping.
//
// It deliberately does NOT match the lowercase ghcr path `ghcr.io/insforge/insta-oss/templates/*`.
// A container package does not move when its source repo is renamed, so those images genuinely
// still live under the old name and the reference is correct.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

/** Case-sensitive on the owner, so the lowercase ghcr package path never matches. */
const OLD_SLUG = /InsForge\/insta-(oss|cli|skills)\b/

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  // Historical design records: they describe what was true when written.
  'plans',
  // Vendored copies synced from the skills repo; fixing them here would only drift from source.
  '.agents',
  '.claude',
])

/** Every exception is a place the OLD slug is still the CORRECT string. */
function isAllowed(relPath: string, line: string): boolean {
  // Template manifests keep `sourceRepo:` on the old slug on purpose. It is metadata nothing
  // resolves through, and editing a published template's manifest forces a version bump, which
  // republishes its image and shows "update available" on every deployed instance.
  if (/^(templates|e2e\/fixtures)\/[^/]+\/insta\.template\.yaml$/.test(relPath)) {
    return /^\s*sourceRepo:/.test(line)
  }
  // Fixtures standing in for READMEs already published in the wild, proving the deploy-badge
  // stripper stays slug-agnostic. Narrowed to the badge URL itself rather than the whole file, so
  // an unrelated stale repo URL added to this test later is still caught.
  if (relPath === 'templates/scripts/publish-lib.test.mjs') {
    return /cdn\.jsdelivr\.net\/gh\/InsForge\/insta-oss@/.test(line)
  }
  return false
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    // Scratch files and editor state, not repo content.
    if (entry.startsWith('.') && dir === ROOT) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) yield* walk(abs)
    else yield abs
  }
}

const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|zip|gz|tar|pdf|webp|mp4)$/i

describe('repo slugs', () => {
  it('ships no URL pointing at a pre-rename repo name', () => {
    const offenders: string[] = []
    for (const abs of walk(ROOT)) {
      if (BINARY.test(abs)) continue
      if (abs.endsWith('package-lock.json')) continue
      let text: string
      try { text = readFileSync(abs, 'utf8') } catch { continue }
      if (!OLD_SLUG.test(text)) continue
      const relPath = relative(ROOT, abs).split(sep).join('/')
      text.split('\n').forEach((line, i) => {
        if (!OLD_SLUG.test(line)) return
        if (isAllowed(relPath, line)) return
        offenders.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders, `old repo slugs must be updated to the instacloud-* names:\n${offenders.join('\n')}`)
      .toEqual([])
  })

  // The product is "InstaCloud OSS" in user-facing prose. The first pass at this missed four doc
  // pages, because the check filtered out whole LINES containing "InsForge/" and those four carried
  // the prose and a repo URL on the same line — a false clean. So this matches on the occurrence,
  // never the line. The lookarounds keep the identifiers that deliberately stay: `~/.insta-oss`
  // (leading dot), `InsForge/instacloud-oss` and `ghcr.io/insforge/insta-oss/...` (leading slash),
  // and `insta-oss-ui` (trailing hyphen).
  it('calls the product InstaCloud OSS in user-facing prose', () => {
    const PROSE = /(?<![./\w-])insta-oss(?![-\w/])/
    const docs = [...walk(join(ROOT, 'docs'))].filter((p) => p.endsWith('.mdx') || p.endsWith('.md'))
    const offenders: string[] = []
    for (const abs of [...docs, join(ROOT, 'README.md'), join(ROOT, 'COMPATIBILITY.md'), join(ROOT, 'CONTRIBUTING.md')]) {
      const relPath = relative(ROOT, abs).split(sep).join('/')
      readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (PROSE.test(line)) offenders.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 110)}`)
      })
    }
    expect(offenders, `use "InstaCloud OSS" for the product name:\n${offenders.join('\n')}`).toEqual([])
  })

  it('still guards the file whose fallback the rename sweep originally missed', () => {
    const publish = readFileSync(join(ROOT, 'templates/scripts/publish.mjs'), 'utf8')
    expect(publish).toContain('const DEFAULT_REPO = "InsForge/instacloud-oss"')
    // `||`, not `??`: an explicitly exported GITHUB_REPOSITORY="" is empty but not nullish, and
    // would otherwise build `cdn.jsdelivr.net/gh/@<sha>/…`.
    expect(publish).not.toMatch(/GITHUB_REPOSITORY\s*\?\?/)
    expect(publish.match(/GITHUB_REPOSITORY \|\| DEFAULT_REPO/g)).toHaveLength(2)
  })
})
