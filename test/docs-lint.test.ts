// Copy and shape rules for the docs that ship with the repository. No Docker, no daemon: this
// suite only reads files, so it is cheap enough to keep in `npm test`.
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = join(__dirname, '..')
const EM_DASH = '—'

const walk = (dir: string, keep: (f: string) => boolean): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`
    const st = statSync(join(root, rel))
    if (st.isDirectory()) out.push(...walk(rel, keep))
    else if (keep(entry)) out.push(rel)
  }
  return out
}

const mdxPages = () => walk('docs', (f) => f.endsWith('.mdx'))

// Pages the em-dash sweep has not reached yet. Every entry is a page WP8 does not own; the list
// only ever shrinks, and a new page may never join it.
const EM_DASH_LEGACY = new Set([
  'docs/agents/branch-per-task.mdx',
  'docs/agents/mcp-server.mdx',
  'docs/agents/setup.mdx',
  'docs/agents/skills.mdx',
  'docs/compute/overview.mdx',
  'docs/deploy/overview.mdx',
  'docs/postgres/overview.mdx',
  'docs/reference/cli/overview.mdx',
  'docs/storage/overview.mdx',
])

test('docs copy uses no em dashes', () => {
  const files = [
    'README.md',
    'COMPATIBILITY.md',
    'CONTRIBUTING.md',
    'templates/AGENTS.md',
    ...mdxPages().filter((f) => !EM_DASH_LEGACY.has(f)),
    ...walk('e2e', () => true),
  ]
  const offenders = files.filter((f) => readFileSync(join(root, f), 'utf8').includes(EM_DASH))
  expect(offenders).toEqual([])
})

test('the em dash allowlist names only files that exist and still carry one', () => {
  for (const f of EM_DASH_LEGACY) {
    expect(readFileSync(join(root, f), 'utf8').includes(EM_DASH), `${f} is clean now`).toBe(true)
  }
})

test('every docs page is listed in the docs.json navigation', () => {
  const nav = JSON.parse(readFileSync(join(root, 'docs/docs.json'), 'utf8')) as unknown
  const listed = new Set<string>()
  const collect = (node: unknown): void => {
    if (typeof node === 'string') listed.add(node)
    else if (Array.isArray(node)) node.forEach(collect)
    else if (node && typeof node === 'object') Object.values(node).forEach(collect)
  }
  collect((nav as { navigation: unknown }).navigation)
  const missing = mdxPages()
    .map((f) => relative('docs', f).split(sep).join('/').replace(/\.mdx$/, ''))
    .filter((page) => !listed.has(page))
  expect(missing).toEqual([])
})

test('the e2e scripts are valid POSIX sh and executable', () => {
  for (const script of ['e2e/lib.sh', 'e2e/local-smoke.sh', 'e2e/server-smoke.sh']) {
    const path = join(root, script)
    execFileSync('sh', ['-n', path])
    expect(() => accessSync(path, constants.X_OK), `${script} is not executable`).not.toThrow()
  }
})

const FIXTURE = 'e2e/fixtures/tpl-hello/insta.template.yaml'

test('the e2e template fixture is a valid draft manifest', async () => {
  const text = readFileSync(join(root, FIXTURE), 'utf8')
  // Pinned to a tag, never a floating one: a fixture that drifts turns an e2e failure into a
  // guessing game.
  expect(text).toMatch(/image: docker\.io\/traefik\/whoami:v[0-9]/)
  expect(text).toMatch(/^ {2}draft: true$/m)
  expect(text).toMatch(/^ {2}category: /m)

  // The parser is WP5's module. Until it lands, the shape checks above stand on their own.
  let parse: ((input: string, opts: { rejectAuthoredSizing: boolean }) => unknown) | undefined
  let collect: ((m: unknown) => { name: string; description?: string; required?: boolean }[]) | undefined
  try {
    const mod = (await import('../src/templates/manifest')) as Record<string, unknown>
    parse = mod.parseTemplateManifest as typeof parse
    collect = mod.collectVariables as typeof collect
  } catch {
    parse = undefined
  }
  if (!parse) return

  const manifest = parse(text, { rejectAuthoredSizing: true }) as {
    code: string
    meta?: { draft?: boolean }
  }
  expect(manifest.code).toBe('tpl-hello')
  expect(manifest.meta?.draft).toBe(true)
  if (collect) {
    for (const v of collect(manifest).filter((x) => x.required)) {
      expect(v.description, `${v.name} has no description`).toBeTruthy()
    }
  }
})

// The verbs below are the ones the CLI actually ships. The invented ones are mistakes made
// while writing these docs, so the table is guarded against them coming back.
const CLI_VERBS = [
  'compute set-domain',
  'compute check-domain',
  'compute remove-domain',
  'compute limits',
  'compute always-on',
  'template list',
  'template info',
  'template deploy',
  'db url',
  'db always-on',
  'services add postgres',
  'POST /tokens',
]

const INVENTED = ['compute domain add', 'tokens list', 'insta tokens']

test('COMPATIBILITY names every new route by its real verb', () => {
  const text = readFileSync(join(root, 'COMPATIBILITY.md'), 'utf8')
  expect(CLI_VERBS.filter((v) => !text.includes(v))).toEqual([])
  expect(INVENTED.filter((v) => text.includes(v))).toEqual([])
  // `insta backup` does not exist, so the only allowed mention is the one that says so.
  expect(text).toMatch(/no `insta backup` command/)
})
