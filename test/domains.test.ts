// The four custom-domain routes end to end over the API (contract 00 section 9, decision 25). They
// had no HTTP-level coverage: `test/internal.test.ts` reached them only through `engine`, and it
// did so against the real system resolver, so the one property the CLI depends on most, that the
// envelope carries NO `ssl` key, was pinned nowhere. DNS is the fake resolver from `test/fakes.ts`.
import { test, expect, beforeEach } from 'vitest'
import { buildServer } from '../src/server'
import { dnsRecords, makeEngine, resetFakes, testConfig } from './fakes'
import type { FastifyInstance } from 'fastify'
import type { Engine } from '../src/engine'

let app: FastifyInstance
let engine: Engine
let projectId: string

const json = (r: { json(): unknown }): Record<string, unknown> => r.json() as Record<string, unknown>

beforeEach(async () => {
  resetFakes()
  engine = makeEngine(testConfig())
  app = buildServer(engine)
  const { project } = await engine.createProject('demo')
  projectId = project.id
  await engine.deploy(projectId, 'main', { image: 'nginx', port: 80 })
})

const post = (body: unknown): Promise<{ statusCode: number; json(): unknown }> =>
  app.inject({ method: 'POST', url: `/projects/${projectId}/compute/domain`, payload: body })
const get = (qs: string): Promise<{ statusCode: number; json(): unknown }> =>
  app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domain?${qs}` })

// Every key `insta compute check-domain` reads, and every key whose PRESENCE changes how it reads
// the answer: an `ssl` key makes the CLI treat this as a cloud plane response and demand an
// ownership TXT record it will never get here.
const FORBIDDEN = ['ssl', 'origin', 'edgeOrigin', 'originOk', 'originStatus']

test('attach: the envelope is the cloud shape, and it carries none of the plane-only keys', async () => {
  const r = await post({ hostname: 'App.Example.COM.' })
  expect(r.statusCode).toBe(200)
  const b = json(r)
  // Normalised: lowercased, trailing dot stripped.
  expect(b.hostname).toBe('app.example.com')
  expect(b.service).toBe('default')
  expect(b.region).toBe('local')
  expect(b.flyApp).toBe('io-demo-main-app-default')
  for (const k of FORBIDDEN) expect(Object.keys(b), k).not.toContain(k)
  // Nothing resolves in the fake resolver, so the record is missing and the domain is pending.
  expect(b.configured).toBe(false)
  expect(b.status).toBe('pending')
  expect(b.dns).toEqual([{ type: 'CNAME', name: 'app.example.com', value: 'api.localhost', status: 'missing' }])
})

test('the dns verdict follows the record: a CNAME to us is ok, an A record elsewhere is a mismatch', async () => {
  dnsRecords.set('api.localhost', { a: ['203.0.113.7'] })

  dnsRecords.set('cname.example.com', { cname: ['api.localhost.'] })
  await post({ hostname: 'cname.example.com' })
  let b = json(await get('hostname=cname.example.com'))
  expect((b.dns as { status: string }[])[0].status).toBe('ok')
  // `configured` is the dns verdict in local mode (no certificate store to consult).
  expect(b.configured).toBe(true)
  expect(b.status).toBe('ready')

  dnsRecords.set('a-hit.example.com', { a: ['203.0.113.7'] })
  await post({ hostname: 'a-hit.example.com' })
  expect(((json(await get('hostname=a-hit.example.com')).dns as { status: string }[])[0]).status).toBe('ok')

  dnsRecords.set('elsewhere.example.com', { a: ['198.51.100.9'] })
  await post({ hostname: 'elsewhere.example.com' })
  b = json(await get('hostname=elsewhere.example.com'))
  expect((b.dns as { status: string }[])[0].status).toBe('mismatch')
  expect(b.configured).toBe(false)
})

test('an unattached name reads `not added` with an empty dns list, never a 404', async () => {
  const b = json(await get('hostname=never-added.example.com'))
  expect(b.status).toBe('not added')
  expect(b.configured).toBe(false)
  expect(b.dns).toEqual([])
  for (const k of FORBIDDEN) expect(Object.keys(b), k).not.toContain(k)
})

test('refusals: a name under our own domain, an IP literal, a bad label and a missing hostname are 400', async () => {
  expect((await post({ hostname: 'api.localhost' })).statusCode).toBe(400)
  expect((await post({ hostname: 'anything.localhost' })).statusCode).toBe(400)
  expect((await post({ hostname: '203.0.113.7' })).statusCode).toBe(400)
  expect((await post({ hostname: 'no-dot' })).statusCode).toBe(400)
  expect((await post({ hostname: 'under_score.example.com' })).statusCode).toBe(400)
  expect((await post({})).statusCode).toBe(400)
  // A traversal attempt is a bad label, not a path: nothing built from a hostname reaches the disk.
  expect((await post({ hostname: '../../etc/passwd' })).statusCode).toBe(400)
})

test('re-attaching to the same target is idempotent; another group is 409 and does not steal it', async () => {
  expect((await post({ hostname: 'app.example.com' })).statusCode).toBe(200)
  expect((await post({ hostname: 'app.example.com' })).statusCode).toBe(200)

  await engine.deploy(projectId, 'main', { group: 'worker', image: 'nginx', port: 80 })
  const clash = await post({ hostname: 'app.example.com', group: 'worker' })
  expect(clash.statusCode).toBe(409)
  expect(String(json(clash).error)).toContain('already attached to default')
  // The original binding is untouched.
  expect(json(await get('hostname=app.example.com')).service).toBe('default')
})

test('list returns one envelope per attached name and detach takes it back out', async () => {
  await post({ hostname: 'one.example.com' })
  await post({ hostname: 'two.example.com' })
  const list = json(await app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domains` }))
  expect((list.items as { hostname: string }[]).map((i) => i.hostname).sort()).toEqual(['one.example.com', 'two.example.com'])

  const del = await app.inject({ method: 'DELETE', url: `/projects/${projectId}/compute/domain`, payload: { hostname: 'one.example.com' } })
  expect(del.statusCode).toBe(200)
  expect(json(del)).toEqual({ hostname: 'one.example.com', flyApp: 'io-demo-main-app-default', service: 'default', region: 'local' })
  expect((json(await app.inject({ method: 'GET', url: `/projects/${projectId}/compute/domains` })).items as unknown[]).length).toBe(1)
  // A second detach is a 404: the row is gone, not silently re-answered.
  expect((await app.inject({ method: 'DELETE', url: `/projects/${projectId}/compute/domain`, payload: { hostname: 'one.example.com' } })).statusCode).toBe(404)
})
