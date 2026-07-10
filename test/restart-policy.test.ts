// A docker-daemon restart (reboot, Desktop update) must not take environments down for good:
// every long-lived container gets --restart unless-stopped. (Found live: a reboot left all
// branch apps+dbs Exited(255) until hand-started.)
import { test, expect, vi } from 'vitest'

const calls: string[][] = []
vi.mock('../src/docker', () => ({ docker: vi.fn(async (args: string[]) => { calls.push(args); return Buffer.from('') }) }))

import { DockerCompute } from '../src/adapters/compute'
import { LocalPostgres } from '../src/adapters/postgres'

const restartArgs = (a: string[]) => a[0] === 'run' && a.includes('--restart') && a[a.indexOf('--restart') + 1] === 'unless-stopped'

test('app containers survive docker restarts', async () => {
  await new DockerCompute().deploy('p-main', { image: 'i', port: 3000, hostPort: 3000, network: 'io-p-main', envVars: {}, group: 'default' })
  expect(calls.filter((a) => a[0] === 'run').every(restartArgs)).toBe(true)
})

test('branch postgres survives docker restarts', async () => {
  calls.length = 0
  await new LocalPostgres().provision('p-main', 'io-p-main')
  expect(calls.filter((a) => a[0] === 'run').every(restartArgs)).toBe(true)
})
