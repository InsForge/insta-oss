// The root vitest config runs `ui/src/lib/**/*.test.ts` (plan 07: no second vitest install under
// ui/). CI installs ONLY the root package (`.github/workflows/ci.yml`: `npm ci`, never
// `npm --prefix ui ci`), so nothing under ui/ can resolve a ui-only dependency during `npm test`.
//
// A test beside a module that imports one fails to LOAD, and that failure mode is nastier than it
// sounds: vitest reports it as a failed FILE, so the summary reads "N passed" with zero failing
// tests while the process exits 1. It looks green and turns CI red — which is exactly what
// happened when localPref.test.ts landed beside a module importing `react`, and the whole point of
// those tests (they never ran) was lost for three commits.
//
// So: a module under ui/src/lib that has a co-located test may not import a ui-only package. Put
// the pure half in its own module and test that, as localPrefStore.ts does for localPref.ts.

import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LIB = join(import.meta.dirname, '..', 'ui', 'src', 'lib')

/** Bare specifiers the ROOT install cannot resolve. Relative and node: imports are always fine. */
const UI_ONLY = /^(react|react-dom|react-router-dom|recharts|lucide-react|@insforge\/|@radix-ui\/)/

const importsOf = (src: string): string[] =>
  [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

test('a ui/src/lib module with a co-located test imports nothing the root install lacks', () => {
  const files = readdirSync(LIB).filter((f) => f.endsWith('.ts'))
  const tested = new Set(files.filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', '.ts')))
  expect(tested.size).toBeGreaterThan(5) // the guard is worthless if it scans nothing

  const offenders: string[] = []
  for (const f of files) {
    if (f.endsWith('.test.ts') || !tested.has(f)) continue
    for (const spec of importsOf(readFileSync(join(LIB, f), 'utf8'))) {
      if (UI_ONLY.test(spec)) offenders.push(`${f} imports ${spec}`)
    }
  }
  expect(offenders, 'move the pure half into its own module and test that instead').toEqual([])
})

test('the test files themselves import nothing the root install lacks', () => {
  const offenders: string[] = []
  for (const f of readdirSync(LIB).filter((f) => f.endsWith('.test.ts'))) {
    for (const spec of importsOf(readFileSync(join(LIB, f), 'utf8'))) {
      if (UI_ONLY.test(spec)) offenders.push(`${f} imports ${spec}`)
    }
  }
  expect(offenders).toEqual([])
})
