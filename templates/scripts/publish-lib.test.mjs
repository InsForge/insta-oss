import { describe, expect, it } from 'vitest'
import { ghcrGateMessage, parseGhcrRef, rewriteReadme } from './publish-lib.mjs'

const SHA = 'a'.repeat(40)
const REPO = 'InsForge/insta-oss'
const DIR = 'templates/example'
const cdn = (p) => `https://cdn.jsdelivr.net/gh/${REPO}@${SHA}/${p}`

// The rewriter is told which resolved paths are directories, so these tests need no filesystem.
const rewrite = (text, isDirectory = () => false) =>
  rewriteReadme(text, { dirInRepo: DIR, repo: REPO, sha: SHA, isDirectory })

describe('parseGhcrRef', () => {
  it('splits a multi-segment name from its tag', () => {
    expect(parseGhcrRef('ghcr.io/insforge/insta-oss/templates/codex:0.3.0'))
      .toEqual({ repo: 'insforge/insta-oss/templates/codex', tag: '0.3.0' })
  })

  it('splits a digest reference', () => {
    expect(parseGhcrRef('ghcr.io/owner/name@sha256:abc'))
      .toEqual({ repo: 'owner/name', tag: 'sha256:abc' })
  })

  it('defaults a tagless reference to latest', () => {
    expect(parseGhcrRef('ghcr.io/owner/name')).toEqual({ repo: 'owner/name', tag: 'latest' })
  })

  it('ignores registries it does not gate', () => {
    expect(parseGhcrRef('docker.io/n8nio/n8n:2.10.2')).toBeNull()
    expect(parseGhcrRef(undefined)).toBeNull()
  })
})

describe('ghcrGateMessage', () => {
  const base = { name: 'workspace', ref: 'ghcr.io/o/n:1', anon: 403 }

  it('names package visibility when the image exists but is not anonymous', () => {
    const msg = ghcrGateMessage({ ...base, auth: 0 })
    expect(msg).toContain('NOT anonymously pullable')
    expect(msg).toContain('Change visibility')
    // The operator must not be sent looking for a build that already succeeded.
    expect(msg).not.toContain('not published yet')
  })

  it('offers both causes when the authenticated probe also failed', () => {
    const msg = ghcrGateMessage({ ...base, auth: 404 })
    expect(msg).toContain('authenticated HTTP 404')
    expect(msg).toContain('not published yet')
  })

  it('says so when there was no token to classify with', () => {
    expect(ghcrGateMessage({ ...base, auth: null })).toContain('no GHCR_TOKEN was set')
  })
})

describe('rewriteReadme', () => {
  it('sends relative images to the CDN, in every spelling', () => {
    const out = rewrite([
      '![a](./shot.png)',
      '![b](shot.png)',
      '![c](./shot.png "a title")',
      '![d](./shot.png#frag)',
      '<img src="./shot.png" width="200">',
      "<img src='shot.png'>",
    ].join('\n'))
    expect(out).toBe([
      `![a](${cdn(`${DIR}/shot.png`)})`,
      `![b](${cdn(`${DIR}/shot.png`)})`,
      `![c](${cdn(`${DIR}/shot.png`)} "a title")`,
      `![d](${cdn(`${DIR}/shot.png`)}#frag)`,
      `<img src="${cdn(`${DIR}/shot.png`)}" width="200">`,
      `<img src='${cdn(`${DIR}/shot.png`)}'>`,
    ].join('\n'))
  })

  it('leaves absolute, root-relative and anchor targets alone', () => {
    const text = [
      '![x](https://example.com/a.png)',
      '[y](https://instacloud.com/templates)',
      '[z](#a-heading)',
      '[w](/absolute/path)',
      '[v](mailto:info@insforge.dev)',
    ].join('\n')
    expect(rewrite(text)).toBe(text)
  })

  it('links files with blob and directories with tree', () => {
    const isDirectory = (p) => p === 'templates/hermes'
    const out = rewrite('[doc](../QA.md) [dir](../hermes/) [dir2](../hermes)', isDirectory)
    expect(out).toContain(`https://github.com/${REPO}/blob/${SHA}/templates/QA.md`)
    // A trailing slash is a directory even when the caller cannot stat it...
    expect(out).toContain(`https://github.com/${REPO}/tree/${SHA}/templates/hermes)`)
    // ...and so is a path isDirectory() recognises, which is the deepseek-hermes -> hermes case.
    expect(out.match(new RegExp(`${REPO}/tree/`, 'g'))).toHaveLength(2)
    expect(out).not.toContain(`blob/${SHA}/templates/hermes`)
  })

  it('refuses an image that reaches outside its own template directory', () => {
    expect(() => rewrite('![x](../hermes/logo.png)')).toThrow(/points outside the template directory/)
  })

  it('refuses a target that climbs out of the repository', () => {
    expect(() => rewrite('[x](../../../etc/passwd)')).toThrow(/escapes the repository/)
  })

  it('publishes the text unchanged when there is nothing to rewrite', () => {
    const text = '# Title\n\nPlain prose with `code` and a list:\n\n- one\n- two\n'
    expect(rewrite(text)).toBe(text)
  })
})
