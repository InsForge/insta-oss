// The data-dir copy helper (src/fsclone.cjs) is what carries user data across a fork: a compute
// /data volume through the `clone` verb, a Postgres data directory through `clone --pg`. It runs as
// a short-lived child process with two engines, `ficlone` on Linux and `cp-c` on macOS, so it is
// exercised here the way the daemon runs it: argv in, JSON out, on a real temporary directory with
// the engine this platform actually uses.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const HELPER = new URL('../src/fsclone.cjs', import.meta.url).pathname
const ENGINE = process.platform === 'darwin' ? 'cp-c' : 'ficlone'

let root = ''

const clone = (src: string, dst: string, extra: string[] = []): { method: string; files: number } => {
  const out = execFileSync(process.execPath, [HELPER, 'clone', src, dst, '--reflink=auto', `--engine=${ENGINE}`, ...extra], { encoding: 'utf8' })
  return JSON.parse(out) as { method: string; files: number }
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fsclone-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

test('clone puts the CONTENTS of the source under the destination, not the source directory', () => {
  const src = join(root, 'vol-id')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'marker'), 'forked\n')
  writeFileSync(join(src, 'sub', 'nested'), 'deep\n')
  const dst = join(root, 'copy-id')
  mkdirSync(dst, { recursive: true })   // forkVolumes creates it before copying

  const res = clone(src, dst)

  expect(readFileSync(join(dst, 'marker'), 'utf8')).toBe('forked\n')
  expect(readFileSync(join(dst, 'sub', 'nested'), 'utf8')).toBe('deep\n')
  // The bug this pins: `cp -a src/. dst/` on BSD cp nested the source directory one level down,
  // so the branch's container mounted an empty /data with a single directory in it.
  expect(readdirSync(dst).sort()).toEqual(['marker', 'sub'])
  expect(readdirSync(dst)).not.toContain(basename(src))
  expect(res.files).toBeGreaterThan(0)
})

test('clone recreates a symlink as a symlink and copies a dotfile', () => {
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'real'), 'target\n')
  writeFileSync(join(src, '.hidden'), 'dot\n')
  symlinkSync('real', join(src, 'link'))
  const dst = join(root, 'dst')

  clone(src, dst)

  expect(readdirSync(dst).sort()).toEqual(['.hidden', 'link', 'real'])
  expect(readFileSync(join(dst, 'link'), 'utf8')).toBe('target\n')
})

test('clone --pg copies a data directory, PG_VERSION included, and stat reads it back', () => {
  const src = join(root, 'pg-main')
  mkdirSync(join(src, 'base'), { recursive: true })
  writeFileSync(join(src, 'PG_VERSION'), '16\n')
  writeFileSync(join(src, 'base', 'page'), 'x'.repeat(1024))
  const dst = join(root, 'pg-feat')

  clone(src, dst, ['--pg'])

  expect(readFileSync(join(dst, 'PG_VERSION'), 'utf8')).toBe('16\n')
  expect(readFileSync(join(dst, 'base', 'page'), 'utf8').length).toBe(1024)
  const stat = JSON.parse(execFileSync(process.execPath, [HELPER, 'stat', dst], { encoding: 'utf8' })) as { exists: boolean; pgVersion: string | null }
  expect(stat).toEqual({ exists: true, pgVersion: '16' })
})

test('isempty distinguishes an empty directory from a missing one and from a full one', () => {
  const empty = join(root, 'empty')
  mkdirSync(empty)
  const full = join(root, 'full')
  mkdirSync(full)
  writeFileSync(join(full, 'f'), 'x')
  const read = (dir: string): { empty: boolean } =>
    JSON.parse(execFileSync(process.execPath, [HELPER, 'isempty', dir], { encoding: 'utf8' })) as { empty: boolean }

  expect(read(empty).empty).toBe(true)
  expect(read(join(root, 'missing')).empty).toBe(true)
  expect(read(full).empty).toBe(false)
})
