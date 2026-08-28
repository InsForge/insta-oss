// A docker-daemon restart (reboot, Desktop update) must not take environments down for good:
// every long-lived container gets --restart unless-stopped. (Found live: a reboot left all
// branch apps+dbs Exited(255) until hand-started.)
import { test, expect, vi } from 'vitest'

const calls: string[][] = []
vi.mock('../src/docker', () => ({ docker: vi.fn(async (args: string[]) => { calls.push(args); return Buffer.from('') }) }))

import { DockerCompute } from '../src/adapters/compute'
import { LocalPostgres } from '../src/adapters/postgres'

// `create` for compute (the container is started separately so a stopped service's replacement is
// not run), `run` for the database. Asserted per verb, and each test asserts the call it expects
// EXISTS — filter().every() is vacuously true on an empty list, so a verb rename would otherwise
// disable the guard silently rather than fail it.
const restartArgs = (verb: string) => (a: string[]) =>
  a[0] === verb && a.includes('--restart') && a[a.indexOf('--restart') + 1] === 'unless-stopped'

test('app containers survive docker restarts', async () => {
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  const creates = calls.filter((a) => a[0] === 'create')
  expect(creates.length).toBeGreaterThan(0)
  expect(creates.every(restartArgs('create'))).toBe(true)
})

test('a deploy whose service is down creates the container without starting it', async () => {
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default', start: false })
  expect(calls.some((a) => a[0] === 'create')).toBe(true)
  expect(calls.some((a) => a[0] === 'start')).toBe(false)
})

test('a deploy whose service is up starts it', async () => {
  calls.length = 0
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  expect(calls.some((a) => a[0] === 'start' && a[1] === 'io-p-main-app-default')).toBe(true)
})

test('branch postgres survives docker restarts', async () => {
  calls.length = 0
  await new LocalPostgres().provision('p-main', 'io-p-main')
  const runs = calls.filter((a) => a[0] === 'run')
  expect(runs.length).toBeGreaterThan(0)
  expect(runs.every(restartArgs('run'))).toBe(true)
})
