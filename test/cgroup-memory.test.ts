// `cgroupMemory` reads THIS process's own cgroup v2 ceiling, which is the only thing that can tell
// an instad inside a container how much room it really has: /proc/meminfo describes the machine.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { cgroupMemory } from '../src/scheduler'

const dirs: string[] = []

function cgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'io-cgroup-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

test('an unlimited cgroup answers null, so /proc/meminfo stands', () => {
  expect(cgroupMemory(cgroup({ 'memory.max': 'max\n', 'memory.current': '1000\n' }))).toBeNull()
})

test('a machine with no cgroup v2 files answers null', () => {
  expect(cgroupMemory(join(tmpdir(), 'io-cgroup-does-not-exist'))).toBeNull()
})

test('a ceiling answers total and available, counting reclaimable cache as free', () => {
  const dir = cgroup({
    'memory.max': `${512 * 1024 * 1024}\n`,
    'memory.current': `${400 * 1024 * 1024}\n`,
    'memory.stat': `anon ${300 * 1024 * 1024}\ninactive_file ${80 * 1024 * 1024}\nslab_reclaimable ${20 * 1024 * 1024}\n`,
  })
  expect(cgroupMemory(dir)).toEqual({
    totalBytes: 512 * 1024 * 1024,
    availableBytes: 212 * 1024 * 1024,     // 512 - 400 + 80 + 20
  })
})

test('available never exceeds the ceiling and never goes below zero', () => {
  const roomy = cgroup({
    'memory.max': `${100}\n`,
    'memory.current': `${10}\n`,
    'memory.stat': `inactive_file ${1000}\n`,
  })
  expect(cgroupMemory(roomy)?.availableBytes).toBe(100)
  const full = cgroup({ 'memory.max': `${100}\n`, 'memory.current': `${400}\n`, 'memory.stat': 'inactive_file 0\n' })
  expect(cgroupMemory(full)?.availableBytes).toBe(0)
})

test('a missing memory.stat still yields a reading, counting cache as used', () => {
  const dir = cgroup({ 'memory.max': `${1000}\n`, 'memory.current': `${250}\n` })
  expect(cgroupMemory(dir)).toEqual({ totalBytes: 1000, availableBytes: 750 })
})

test('a garbled ceiling answers null rather than a nonsense reading', () => {
  expect(cgroupMemory(cgroup({ 'memory.max': 'nope\n', 'memory.current': '1\n' }))).toBeNull()
  expect(cgroupMemory(cgroup({ 'memory.max': '0\n', 'memory.current': '1\n' }))).toBeNull()
  expect(cgroupMemory(cgroup({ 'memory.max': '1000\n', 'memory.current': 'nope\n' }))).toBeNull()
})
