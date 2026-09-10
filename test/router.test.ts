// The router with real listeners on ephemeral ports and fake seams (contract 00 section 8.2, 02
// sections 0 to 8). What these tests pin is the serverless behaviour: a request for a sleeping
// service waits for exactly one wake, the waiting keeps the service awake through ONE shared timer,
// and every failure mode has a readable answer instead of a dropped connection.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type Server as NetServer } from 'node:net'
import { connect as tlsConnect, type SecureContext } from 'node:tls'
import { Router } from '../src/router'
import { Certs, findCertFiles } from '../src/router/certs'
import { createPgLane, errorResponse, PG_ERRORS } from '../src/router/pg'
import { createSniLane } from '../src/router/tls'
import { buildTable, type Route } from '../src/router/table'
import { SSL_REQUEST, startupMessage } from '../src/router/wake'
import type { ServiceState, UpstreamAddr, UpstreamLike } from '../src/router/deps'
import type { Config } from '../src/config'
import type { State } from '../src/state'
import { makeEngine, resetFakes, serverConfig, testConfig } from './fakes'
import type { Branch, Project } from '../src/types'

// ---- fakes -------------------------------------------------------------------------------------

class FakeUpstream implements UpstreamLike {
  readonly addrs = new Map<string, { host: string; port: number }>()
  readonly forgotten: string[] = []
  async resolve(container: string): Promise<UpstreamAddr | null> {
    const a = this.addrs.get(container)
    return a ? { host: a.host, port: a.port, containerId: `id-${container}`, startedAt: '' } : null
  }
  forget(container: string): void { this.forgotten.push(container) }
  forgetIfChanged(): void { /* the sweep's job, not the router's */ }
  async dial(): Promise<boolean> { return true }
}

const EMPTY: State = {
  projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {},
  rev: 1, auditRev: 0, customDomains: {}, templateDeployments: {},
}
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'demo', status: 'ready', createdAt: 1, refSlug: 'demo', ...over })
const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', projectId: 'p1', name: 'main', isDefault: true, status: 'ready', ref: 'demo-main',
  network: 'io-demo-main', cloneOf: null, createdAt: 1, apps: {}, ...over,
})

const listenEphemeral = (s: Server | NetServer): Promise<number> => new Promise((resolve, reject) => {
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    resolve(typeof a === 'object' && a ? a.port : 0)
  })
})

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

/** An origin the lane proxies to; `handler` may be swapped between requests. */
interface Origin { port: number; server: Server; requests: IncomingMessage[] }
const origin = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Origin> => {
  const requests: IncomingMessage[] = []
  const server = createHttpServer((req, res) => { requests.push(req); handler(req, res) })
  const port = await listenEphemeral(server)
  return { port, server, requests }
}

interface Harness {
  router: Router
  port: number
  upstream: FakeUpstream
  state: State
  cfg: Config
  wakes: { count: number }
  touched: string[]
  api: { hits: number }
  close(): Promise<void>
}

/** A Router on an ephemeral port with a fake API handler and a singleflight fake wake. The wake
 *  registers the upstream address, so `stateOf` flips to running exactly as the scheduler's does. */
async function harness(cfg: Config, state: State, opts: {
  onWake?: (route: Route) => Promise<void>
  attach?: boolean
  wakeDelayMs?: number
} = {}): Promise<Harness> {
  const upstream = new FakeUpstream()
  const wakes = { count: 0 }
  const touched: string[] = []
  const api = { hits: 0 }
  let inflight: Promise<void> | null = null

  const stateOf = (route: Route): ServiceState => (upstream.addrs.has(route.container) ? 'running' : 'asleep')
  const wake = (route: Route): Promise<void> => {
    // The scheduler is singleflight per key; the router must not add a second map (decision 52).
    if (!inflight) {
      inflight = (async () => {
        wakes.count++
        await delay(opts.wakeDelayMs ?? 5)
        if (opts.onWake) await opts.onWake(route)
      })().finally(() => { inflight = null })
    }
    return inflight
  }

  const router = new Router({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf,
    wake,
    touch: (k) => touched.push(k),
    beginHold: () => { /* the engine's ledger; the router keeps its own counts */ },
    endHold: () => { /* idem */ },
    upstream,
    certs: new Certs({ certDir: cfg.tls.certDir, issue: async () => { /* no issuer in tests */ } }),
    log: () => { /* quiet */ },
  })
  if (opts.attach !== false) router.attach((_req, res) => { api.hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"api":true}') })
  const port = await listenEphemeral(router.httpServer)
  return {
    router, port, upstream, state, cfg, wakes, touched, api,
    close: async () => { await router.stop(); router.httpServer.close() },
  }
}

interface Answer { status: number; body: string; headers: Record<string, string | string[] | undefined> }
const call = (port: number, host: string, path = '/', opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host, ...opts.headers } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.once('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })

beforeEach(() => { resetFakes() })

// ---- HTTP lane ---------------------------------------------------------------------------------

test('the HTTP lane routes by Host, preserves Host and appends X-Forwarded-*', async () => {
  const up = await origin((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok ${req.headers.host}`) })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  const r = await call(h.port, 'web-demo-main.localhost')
  expect(r.status).toBe(200)
  expect(r.body).toBe('ok web-demo-main.localhost')                 // Host reaches the app unchanged
  const seen = up.requests[up.requests.length - 1]
  expect(seen.headers['x-forwarded-host']).toBe('web-demo-main.localhost')
  expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1')
  expect(seen.headers['x-forwarded-proto']).toBe('http')
  // Hop-by-hop headers are per hop: the client's `connection` never reaches the app (the lane's own
  // keep-alive agent sets its own for the second hop).
  await call(h.port, 'web-demo-main.localhost', '/', { headers: { connection: 'close' } })
  expect(up.requests[up.requests.length - 1].headers['connection']).not.toBe('close')

  // The edge's https claim over loopback is honoured.
  await call(h.port, 'web-demo-main.localhost', '/', { headers: { 'x-forwarded-proto': 'https' } })
  expect(up.requests[up.requests.length - 1].headers['x-forwarded-proto']).toBe('https')

  await h.close(); up.server.close()
})

test('daemon hosts go to the API; local mode sends an unknown Host there too, a custom domain still reaches the lane', async () => {
  const up = await origin((_req, res) => { res.writeHead(200); res.end('app') })
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) },
    customDomains: { 'app.example.com': { hostname: 'app.example.com', projectId: 'p1', branchId: 'b1', group: 'web', createdAt: 1 } },
  }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  expect((await call(h.port, '127.0.0.1')).body).toBe('{"api":true}')
  expect((await call(h.port, 'localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'api.localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'console.localhost')).body).toBe('{"api":true}')
  expect((await call(h.port, 'host.docker.internal')).body).toBe('{"api":true}')
  expect((await call(h.port, 'my-laptop.lan')).body).toBe('{"api":true}')     // today's behaviour
  // A custom-domain alias is in the table, so it reaches the lane, not the API.
  expect((await call(h.port, 'app.example.com')).body).toBe('app')

  await h.close(); up.server.close()
})

test('server mode answers an unknown Host with 404 JSON, and api.<domain> with the API', async () => {
  const cfg = serverConfig()
  const h = await harness(cfg, { ...EMPTY })
  expect((await call(h.port, 'api.example.test')).body).toBe('{"api":true}')
  const r = await call(h.port, 'nobody.example.test')
  expect(r.status).toBe(404)
  expect(JSON.parse(r.body)).toEqual({ error: 'unknown route' })
  await h.close()
})

test('a request dispatched to the API before attach() answers 503', async () => {
  const h = await harness(testConfig(), { ...EMPTY }, { attach: false })
  const r = await call(h.port, '127.0.0.1')
  expect(r.status).toBe(503)
  expect(JSON.parse(r.body)).toEqual({ error: 'daemon not ready' })
  await h.close()
})

test('a database host over HTTP is 503 with no HTTP endpoint, and never wakes anything', async () => {
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }, lanes: { 'pg-db': 20000 } }) },
  }
  const h = await harness(testConfig(), state)
  const r = await call(h.port, 'pg-db-demo-main.localhost')
  expect(r.status).toBe(503)
  expect(JSON.parse(r.body)).toEqual({ error: 'this service serves no HTTP endpoint' })
  expect(h.wakes.count).toBe(0)
  await h.close()
})

test('desiredState stopped or suspended answers 503 without calling wake', async () => {
  const state = (desired: 'stopped' | 'suspended'): State => ({
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ apps: { web: { image: 'i', port: 1, url: 'u', desiredState: desired } } }) },
  })
  const stopped = await harness(testConfig(), state('stopped'))
  const a = await call(stopped.port, 'web-demo-main.localhost')
  expect(a.status).toBe(503)
  expect(JSON.parse(a.body)).toEqual({ error: 'service is stopped' })
  expect(stopped.wakes.count).toBe(0)
  await stopped.close()

  const suspended = await harness(testConfig(), state('suspended'))
  const b = await call(suspended.port, 'web-demo-main.localhost')
  expect(b.status).toBe(503)
  expect(JSON.parse(b.body)).toEqual({ error: 'service is suspended' })
  expect(suspended.wakes.count).toBe(0)
  await suspended.close()
})

test('ten concurrent requests on a sleeping route resolve through ONE wake and ONE activity timer', async () => {
  const up = await origin((_req, res) => { res.writeHead(200); res.end('woke') })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const timers = vi.spyOn(globalThis, 'setInterval')
  const h = await harness(testConfig({ INSTA_OSS_TOUCH_DEBOUNCE_MS: '50' }), state, {
    wakeDelayMs: 40,
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })

  const answers = await Promise.all(Array.from({ length: 10 }, () => call(h.port, 'web-demo-main.localhost')))
  expect(answers.every((a) => a.status === 200 && a.body === 'woke')).toBe(true)
  expect(h.wakes.count).toBe(1)
  // One shared ticker for every held key, whatever the number of requests.
  expect(timers.mock.calls.filter((c) => c[1] === 50).length).toBe(1)
  // Every hold released.
  expect(h.router.holds('b1:cp-web')).toBe(0)
  timers.mockRestore()
  await h.close(); up.server.close()
})

test('wake failures map to the cloud-shaped statuses', async () => {
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: 1, url: 'u' } } }) } }
  const cases: Array<[string, number, string]> = [
    ['WakeTimeoutError', 504, 'service wake timed out'],
    ['ServiceStoppedError', 503, 'service is stopped'],
    ['NoContainerError', 503, 'service has no container (deploy in progress or removed)'],
    ['SomethingElse', 503, 'service could not be woken'],
  ]
  for (const [name, status, error] of cases) {
    const h = await harness(testConfig(), state, {
      onWake: async () => {
        const e = new Error(name === 'WakeTimeoutError' ? 'service did not become ready within 60 s' : name === 'ServiceStoppedError' ? 'service is stopped' : name === 'NoContainerError' ? 'service has no container (deploy in progress or removed)' : 'boom')
        Object.defineProperty(e.constructor, 'name', { value: name })
        throw e
      },
    })
    const r = await call(h.port, 'web-demo-main.localhost')
    expect([name, r.status]).toEqual([name, status])
    expect(JSON.parse(r.body)).toEqual({ error })
    await h.close()
  }
})

test('a woken upstream that answers 503 twice then 200 is retried for a bodiless GET', async () => {
  let hits = 0
  const up = await origin((_req, res) => {
    hits++
    if (hits <= 2) { res.writeHead(503); res.end('warming') } else { res.writeHead(200); res.end('ready') }
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_READY_WINDOW_MS: '5000' }), state, {
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })
  const r = await call(h.port, 'web-demo-main.localhost')
  expect(r.status).toBe(200)
  expect(r.body).toBe('ready')
  expect(hits).toBe(3)
  await h.close(); up.server.close()
})

test('a POST that woke the service is gated on HEAD / and then forwarded exactly once', async () => {
  let heads = 0
  let posts = 0
  const up = await origin((req, res) => {
    if (req.method === 'HEAD') { heads++; res.writeHead(heads < 2 ? 503 : 200); res.end(); return }
    posts++
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => { res.writeHead(201, { 'content-type': 'text/plain' }); res.end(`got ${body}`) })
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_READY_WINDOW_MS: '5000' }), state, {
    onWake: async () => { h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port }) },
  })
  const r = await call(h.port, 'web-demo-main.localhost', '/things', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } })
  expect(r.status).toBe(201)
  expect(r.body).toBe('got payload')
  expect(posts).toBe(1)
  expect(heads).toBeGreaterThanOrEqual(2)
  await h.close(); up.server.close()
})

test('a stream is not buffered and the shared ticker keeps stamping while it runs', async () => {
  const up = await origin((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\n\n')
    setTimeout(() => { res.write('data: two\n\n'); res.end() }, 180)
  })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: up.port, url: 'u' } } }) } }
  const h = await harness(testConfig({ INSTA_OSS_TOUCH_DEBOUNCE_MS: '50' }), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: up.port })

  const chunks: string[] = []
  const done = new Promise<void>((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: h.port, path: '/sse', headers: { host: 'web-demo-main.localhost' } }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => chunks.push(c))
      res.on('end', () => resolve())
    })
    req.end()
  })
  await delay(80)
  expect(chunks.join('')).toContain('data: one')     // arrived before the response ended
  expect(h.router.holds('b1:cp-web')).toBe(1)
  await done
  expect(chunks.join('')).toContain('data: two')
  expect(h.router.holds('b1:cp-web')).toBe(0)
  // request start plus at least one 5 s-ticker stamp inside the 180 ms stream
  expect(h.touched.filter((k) => k === 'b1:cp-web').length).toBeGreaterThanOrEqual(2)
  await h.close(); up.server.close()
})

test('a protocol upgrade is spliced raw and held until the socket closes', async () => {
  // A minimal echo upstream: answer the handshake, then mirror every byte.
  const upstream = createNetServer((c) => {
    let head = ''
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      c.off('data', onData)
      c.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
      c.on('data', (d: Buffer) => c.write(d))
    }
    c.on('data', onData)
  })
  const upPort = await listenEphemeral(upstream)
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch({ apps: { web: { image: 'i', port: upPort, url: 'u' } } }) } }
  const h = await harness(testConfig(), state)
  h.upstream.addrs.set('io-demo-main-app-web', { host: '127.0.0.1', port: upPort })

  const client = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => client.once('connect', () => r()))
  client.write('GET /ws HTTP/1.1\r\nhost: web-demo-main.localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
  let seen = ''
  client.on('data', (d: Buffer) => { seen += d.toString('latin1') })
  await delay(120)
  expect(seen).toContain('101 Switching Protocols')
  expect(h.router.holds('b1:cp-web')).toBe(1)
  client.write('ping')
  await delay(120)
  expect(seen).toContain('ping')
  client.destroy()
  await delay(80)
  expect(h.router.holds('b1:cp-web')).toBe(0)
  await h.close(); upstream.close()
})

test('the bucket vhost picks the S3 API for signed or mutating traffic and the web endpoint otherwise', async () => {
  // Two origins standing in for Garage's two ports; the route's upstream is chosen per request, so
  // the test drives the choice through the header and the method and reads back which one answered.
  const api = await origin((_req, res) => { res.writeHead(200); res.end('s3-api') })
  const web = await origin((_req, res) => { res.writeHead(200); res.end('s3-web') })
  const cfg = serverConfig()
  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } } }) },
  }
  const h = await harness(cfg, state)
  // The lane dials 127.0.0.1 on Garage's fixed ports; point those at the two origins by rewriting
  // the table's static routes through a port-mapping proxy is unnecessary: assert the CHOICE instead.
  const chosen: number[] = []
  const spy = vi.spyOn(h.router as unknown as { table(): ReturnType<typeof buildTable> }, 'table')
  spy.mockImplementation(() => {
    const t = buildTable(state, cfg, () => { /* quiet */ })
    return {
      ...t,
      byHost: (host: string) => {
        const r = t.byHost(host)
        if (r?.kind !== 'garage-vhost') return r
        return { ...r }
      },
    }
  })
  spy.mockRestore()

  // Direct assertions on the upstream choice, which is what the lane decides.
  const { HttpLane } = await import('../src/router/http')
  const lane = new HttpLane({
    cfg, upstream: h.upstream, stateOf: () => 'running', wake: async () => { /* static route */ },
    touch: () => { /* no key */ }, beginHold: () => { /* no key */ }, endHold: () => { /* no key */ },
    signal: new AbortController().signal, log: () => { /* quiet */ },
  })
  const pick = (lane as unknown as { staticUpstream(r: Route, req: { headers: Record<string, string>; url: string; method: string }): UpstreamAddr | null }).staticUpstream.bind(lane)
  const vhost = buildTable(state, cfg, () => { /* quiet */ }).byHost('io-demo-main-store.s3.example.test') as Route

  chosen.push(pick(vhost, { headers: { authorization: 'AWS4-HMAC-SHA256 Credential=x' }, url: '/k', method: 'PUT' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k?X-Amz-Signature=abc', method: 'GET' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'DELETE' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'GET' })!.port)
  chosen.push(pick(vhost, { headers: {}, url: '/k', method: 'HEAD' })!.port)
  expect(chosen).toEqual([3900, 3900, 3900, 3902, 3902])

  await h.close(); api.server.close(); web.server.close()
})

// ---- lane listeners ----------------------------------------------------------------------------

test('invalidate() opens the lane of a newly added route and closes a removed one', async () => {
  const cfg = testConfig({ INSTA_OSS_LANE_PORT_RANGE: '31200-31299' })
  const state: State = { ...EMPTY, projects: { p1: project() }, branches: { b1: branch() } }
  const h = await harness(cfg, state)
  await h.router.start()

  const canConnect = (port: number): Promise<boolean> => new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port })
    s.setTimeout(500, () => { s.destroy(); resolve(false) })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })

  expect(await canConnect(31200)).toBe(false)
  state.branches.b1.databases = { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }
  state.branches.b1.lanes = { 'pg-db': 31200 }
  h.router.invalidate()
  await delay(120)
  expect(await canConnect(31200)).toBe(true)

  delete state.branches.b1.databases
  delete state.branches.b1.lanes
  h.router.invalidate()
  await delay(120)
  expect(await canConnect(31200)).toBe(false)

  await h.close()
})

test('a per-service lane port already bound is reallocated with a warning', async () => {
  const cfg = testConfig({ INSTA_OSS_LANE_PORT_RANGE: '31300-31399' })
  const squatter = createNetServer(() => { /* holds the port */ })
  await new Promise<void>((r) => squatter.listen(31300, '127.0.0.1', () => r()))

  const state: State = {
    ...EMPTY, projects: { p1: project() },
    branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container: 'io-demo-main-pg-db', dataId: 'db' } }, lanes: { 'pg-db': 31300 } }) },
  }
  const logs: string[] = []
  const upstream = new FakeUpstream()
  const router = new Router({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => 'running',
    wake: async () => { /* not reached */ },
    touch: () => { /* no-op */ }, beginHold: () => { /* no-op */ }, endHold: () => { /* no-op */ },
    upstream,
    reallocLane: () => { state.branches.b1.lanes = { 'pg-db': 31301 }; return 31301 },
    certs: new Certs({ certDir: null }),
    log: (m) => logs.push(m),
  })
  await listenEphemeral(router.httpServer)
  await router.start()
  await delay(120)

  expect(logs.some((m) => /lane port 31300 .* was in use; moved to 31301/.test(m))).toBe(true)
  await router.stop()
  router.httpServer.close()
  squatter.close()
})

// ---- postgres lane -----------------------------------------------------------------------------

/** A fake postgres upstream: answers `N` to SSLRequest, then echoes with a `Z` prefix so the test can
 *  see bytes travel both ways. */
const fakePg = async (): Promise<{ port: number; server: NetServer; seen: Buffer[] }> => {
  const seen: Buffer[] = []
  const server = createNetServer((c) => {
    let handshook = false
    c.on('data', (d: Buffer) => {
      seen.push(d)
      if (!handshook && d.length >= 8 && d.readUInt32BE(4) === 80877103) { c.write('N'); return }
      handshook = true
      // Anything after the negotiation: answer AuthenticationOk-shaped bytes for the probe and echo.
      c.write(Buffer.concat([Buffer.from('R'), d]))
    })
  })
  return { port: await listenEphemeral(server), server, seen }
}

const pgLaneHarness = async (cfg: Config, state: State, opts: { onWake?: () => void } = {}): Promise<{
  port: number; server: NetServer; upstream: FakeUpstream; wakes: { count: number }; touched: string[]; close(): void
}> => {
  const upstream = new FakeUpstream()
  const wakes = { count: 0 }
  const touched: string[] = []
  const ctrl = new AbortController()
  const certs = new Certs({ certDir: cfg.tls.certDir, issue: async () => { /* none */ } })
  const defaultCtx = cfg.tls.certDir ? await certs.certFor(`api.${cfg.domain}`) : null
  const server = createPgLane({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => (upstream.addrs.size ? 'running' : 'asleep'),
    wake: async () => { wakes.count++; opts.onWake?.() },
    touch: (k) => touched.push(k),
    beginHold: () => { /* counted by the router in production */ },
    endHold: () => { /* idem */ },
    upstream,
    signal: ctrl.signal,
    secureContext: () => defaultCtx,
    sniCallback: certs.sniCallback(() => defaultCtx),
    log: () => { /* quiet */ },
  }, '127.0.0.1', 0)
  const port = await listenEphemeral(server)
  return { port, server, upstream, wakes, touched, close: () => { ctrl.abort(); server.close() } }
}

const pgState = (container: string, lanePort: number): State => ({
  ...EMPTY, projects: { p1: project() },
  branches: { b1: branch({ databases: { 'pg-db': { url: 'u', container, dataId: 'db' } }, lanes: { 'pg-db': lanePort } }) },
})

test('local pg lane: SSLRequest is answered N, the Startup is forwarded and bytes splice both ways', async () => {
  const up = await fakePg()
  const cfg = testConfig()
  const state = pgState('io-demo-main-pg-db', 0)
  const h = await pgLaneHarness(cfg, state, {})
  h.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })
  // The route is looked up by the LOCAL listen port, so the lane port must match the listener.
  state.branches.b1.lanes = { 'pg-db': h.port }

  const c = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => c.once('connect', () => r()))
  const answers: Buffer[] = []
  c.on('data', (d: Buffer) => answers.push(d))
  c.write(SSL_REQUEST)
  await delay(60)
  expect(answers[0]?.toString('latin1')).toBe('N')          // no TLS in local mode

  c.write(startupMessage({ user: 'postgres', database: 'app' }))
  await delay(250)
  expect(up.seen.some((b) => b.includes('postgres'))).toBe(true)
  expect(Buffer.concat(answers.slice(1)).length).toBeGreaterThan(0)   // the upstream's bytes came back
  expect(h.touched).toContain('b1:pg-db')
  c.destroy()
  h.close(); up.server.close()
})

test('local pg lane: a plaintext Startup arrives first and is still forwarded after the wake', async () => {
  const up = await fakePg()
  const cfg = testConfig()
  const state = pgState('io-demo-main-pg-db', 0)
  const h = await pgLaneHarness(cfg, state, {})
  state.branches.b1.lanes = { 'pg-db': h.port }
  // Asleep at first: the wake registers the address, exactly as the scheduler's does.
  const withWake = await pgLaneHarness(cfg, state, {})
  withWake.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })
  state.branches.b1.lanes = { 'pg-db': withWake.port }

  const c = netConnect({ host: '127.0.0.1', port: withWake.port })
  await new Promise<void>((r) => c.once('connect', () => r()))
  c.write(startupMessage({ user: 'postgres', database: 'app' }))
  await delay(250)
  expect(up.seen.some((b) => b.includes('postgres'))).toBe(true)
  c.destroy()
  h.close(); withWake.close(); up.server.close()
})

test('server pg lane: SSLRequest is answered S, SNI picks the route, and a plaintext Startup is refused readably', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['router.test', 'api.router.test', 'pg-db-demo-main.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  const up = await fakePg()
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const state = pgState('io-demo-main-pg-db', 5432)
  const h = await pgLaneHarness(cfg, state, {})
  h.upstream.addrs.set('io-demo-main-pg-db', { host: '127.0.0.1', port: up.port })

  // 1. A plaintext Startup: refused with the sentence that names the fix.
  const plain = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => plain.once('connect', () => r()))
  const answered = new Promise<Buffer>((r) => { plain.once('data', (d: Buffer) => r(d)) })
  plain.write(startupMessage({ user: 'postgres', database: 'app' }))
  expect((await answered).toString('latin1')).toContain('sslmode=require')
  plain.destroy()

  // 2. SSLRequest then TLS with the right SNI: the connection reaches the upstream.
  const routed = await pgOverTls(h.port, 'pg-db-demo-main.router.test')
  expect(routed.negotiated).toBe('S')
  expect(routed.error).toBeNull()

  // 3. An unknown SNI: a readable ErrorResponse, not a dropped socket.
  const unknown = await pgOverTls(h.port, 'router.test')
  expect(unknown.error).toContain('no database at this hostname')

  h.close(); up.server.close()
})

/** Speak SSLRequest, wrap in TLS with `servername`, then read whatever the lane says. */
async function pgOverTls(port: number, servername: string): Promise<{ negotiated: string; error: string | null }> {
  const raw = netConnect({ host: '127.0.0.1', port })
  await new Promise<void>((r) => raw.once('connect', () => r()))
  raw.write(SSL_REQUEST)
  const negotiated = (await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })).toString('latin1')
  if (negotiated !== 'S') { raw.destroy(); return { negotiated, error: null } }
  const t = tlsConnect({ socket: raw, servername, rejectUnauthorized: false })
  const settled = await new Promise<{ error: string | null }>((resolve) => {
    let answered = false
    t.once('secureConnect', () => {
      t.write(startupMessage({ user: 'postgres', database: 'app' }))
      setTimeout(() => { if (!answered) resolve({ error: null }) }, 250)
    })
    // Only a wire ErrorResponse ('E') is an error; anything else is the upstream answering.
    t.on('data', (d: Buffer) => { answered = true; resolve({ error: d[0] === 0x45 ? d.toString('latin1') : null }) })
    t.once('error', () => { if (!answered) resolve({ error: null }) })
  })
  t.destroy()
  return { negotiated, error: settled.error }
}

test('a client that sends NO SNI completes the handshake on the default context and is told so', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['api.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const h = await pgLaneHarness(cfg, pgState('io-demo-main-pg-db', 5432), {})

  const raw = netConnect({ host: '127.0.0.1', port: h.port })
  await new Promise<void>((r) => raw.once('connect', () => r()))
  raw.write(SSL_REQUEST)
  await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })
  // No `servername`: libpq before 14 and older JDBC drivers behave like this.
  const t = tlsConnect({ socket: raw, rejectUnauthorized: false })
  const answer = await new Promise<string>((resolve) => {
    t.once('secureConnect', () => { /* the handshake must succeed, else the client sees an alert */ })
    t.on('data', (d: Buffer) => resolve(d.toString('latin1')))
    t.once('error', (e) => resolve(`error:${e.message}`))
    setTimeout(() => resolve('timeout'), 1500)
  })
  expect(answer).toContain('sslsni')
  t.destroy()
  h.close()
})

test('the pg lane picks up the default certificate the edge issues AFTER it started listening', async () => {
  // The daemon and the edge come up together, so at router start the store is empty and nothing has
  // asked the edge for `api.<domain>` yet. A default context captured then stays null forever, and
  // every client that sends no SNI (redis-cli without --sni, libpq before 14) gets an opaque TLS
  // alert instead of the sentence that names the fix.
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const certs = new Certs({ certDir, issue: async () => { /* the edge is not up yet */ } })
  expect(await certs.certFor(host)).toBeNull()

  let defaultCtx: SecureContext | null = null
  const ctrl = new AbortController()
  const upstream = new FakeUpstream()
  const server = createPgLane({
    cfg,
    table: () => buildTable(pgState('io-demo-main-pg-db', 5432), cfg, () => { /* quiet */ }),
    stateOf: () => 'running',
    wake: async () => { /* not reached */ },
    touch: () => { /* not reached */ },
    beginHold: () => { /* idem */ },
    endHold: () => { /* idem */ },
    upstream,
    signal: ctrl.signal,
    secureContext: () => defaultCtx,
    sniCallback: certs.sniCallback(() => defaultCtx),
    log: () => { /* quiet */ },
  }, '127.0.0.1', 0)
  const port = await listenEphemeral(server)

  const noSni = async (): Promise<string> => {
    const raw = netConnect({ host: '127.0.0.1', port })
    await new Promise<void>((r) => raw.once('connect', () => r()))
    raw.write(SSL_REQUEST)
    await new Promise<Buffer>((r) => { raw.once('data', (d: Buffer) => r(d)) })
    const t = tlsConnect({ socket: raw, rejectUnauthorized: false })
    const answer = await new Promise<string>((resolve) => {
      t.on('data', (d: Buffer) => resolve(d.toString('latin1')))
      t.once('error', (e) => resolve(`error:${e.message}`))
      setTimeout(() => resolve('timeout'), 1500)
    })
    t.destroy()
    return answer
  }

  // Before the certificate exists there is nothing to present, and the handshake cannot complete.
  expect(await noSni()).not.toContain('sslsni')

  // The edge issues it. `refreshDefaultContext` is what does this in the Router; the lane reads the
  // context per connection, so the very next client is answered.
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  defaultCtx = await certs.certFor(host)
  expect(defaultCtx).not.toBeNull()
  expect(certs.materialFor(host)).not.toBeNull()

  expect(await noSni()).toContain('sslsni')
  ctrl.abort(); server.close()
})

test('the wire ErrorResponse encoding is what libpq parses', () => {
  const e = errorResponse('57P03', 'the database is waking up; retry')
  expect(e[0]).toBe(0x45)
  expect(e.readUInt32BE(1)).toBe(e.length - 1)
  expect(e.toString('latin1')).toContain('C57P03')
  expect(e[e.length - 1]).toBe(0)
  expect(PG_ERRORS.SSL_REQUIRED.toString('latin1')).toContain('sslmode=require')
})

// ---- SNI lane ----------------------------------------------------------------------------------

test('the redis SNI lane treats -LOADING as not ready and +PONG as ready', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  for (const host of ['api.router.test', 'redis-cache-demo-main.router.test']) {
    mkdirSync(join(certDir, 'local', host), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  }
  // The upstream answers -LOADING to the first PING and +PONG afterwards.
  let pings = 0
  const upstream = createNetServer((c) => {
    c.on('data', () => { pings++; c.write(pings === 1 ? '-LOADING redis is loading the dataset in memory\r\n' : '+PONG\r\n') })
  })
  const upPort = await listenEphemeral(upstream)

  const cfg = serverConfig({ INSTA_OSS_DOMAIN: 'router.test', INSTA_OSS_TLS_CERT_DIR: certDir })
  const state: State = {
    ...EMPTY,
    projects: { p1: project({ managedServices: [{ id: 'rd-cache', type: 'redis', name: 'cache', createdAt: 1 }] }) },
    branches: { b1: branch({ managed: { 'rd-cache': { password: 'p' } } }) },
  }
  const fake = new FakeUpstream()
  const certs = new Certs({ certDir, issue: async () => { /* none */ } })
  const defaultCtx = await certs.certFor('api.router.test')
  const ctrl = new AbortController()
  let wakes = 0
  const lane = createSniLane({
    cfg,
    table: () => buildTable(state, cfg, () => { /* quiet */ }),
    stateOf: () => (fake.addrs.size ? 'running' : 'asleep'),
    wake: async () => { wakes++; fake.addrs.set('io-demo-main-rd-cache', { host: '127.0.0.1', port: upPort }) },
    touch: () => { /* stamped */ }, beginHold: () => { /* held */ }, endHold: () => { /* released */ },
    upstream: fake, signal: ctrl.signal, defaultMaterial: certs.materialFor('api.router.test'), sniCallback: certs.sniCallback(defaultCtx),
    log: () => { /* quiet */ },
  }, 'redis', '127.0.0.1', 0)
  const port = await listenEphemeral(lane)

  // A ClientHello with NO SNI must still complete the handshake on the default certificate: the
  // client then reads a close and can see the port, instead of an opaque alert with nothing behind
  // it. `tls.createServer` ignores a `secureContext` option, so this only holds while the lane
  // installs the certificate with `setSecureContext` (decision 21).
  const bare = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
  const bareHandshake = await new Promise<boolean>((resolve) => {
    bare.once('secureConnect', () => resolve(true))
    bare.once('error', () => resolve(false))
    setTimeout(() => resolve(false), 3000)
  })
  expect(bareHandshake).toBe(true)
  bare.destroy()

  const c = tlsConnect({ host: '127.0.0.1', port, servername: 'redis-cache-demo-main.router.test', rejectUnauthorized: false })
  const spliced = await new Promise<boolean>((resolve) => {
    c.once('secureConnect', () => {
      c.write('*1\r\n$4\r\nPING\r\n')
      c.once('data', () => resolve(true))
    })
    c.once('error', () => resolve(false))
    setTimeout(() => resolve(false), 3000)
  })
  expect(wakes).toBe(1)
  expect(pings).toBeGreaterThanOrEqual(2)     // -LOADING was retried
  expect(spliced).toBe(true)
  c.destroy()
  ctrl.abort(); lane.close(); upstream.close()
})

afterEach(() => { vi.restoreAllMocks() })

// ---- certificate store (02 section 8) ----------------------------------------------------------

test('the cert store refuses a servername that is not a hostname before it becomes a path', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  // A real pair OUTSIDE the `<issuer>/<host>/` layout: `join(certDir, 'local', '../x', '../x.crt')`
  // normalises to `<certDir>/x.crt`, so a servername of `../x` served it before the shape check.
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'x.crt'))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'x.key'))

  let issued: string[] = []
  const certs = new Certs({ certDir, issue: async (h) => { issued.push(h) } })
  expect(await certs.certFor(host)).not.toBeNull()
  expect(findCertFiles(certDir, host)).not.toBeNull()

  issued = []
  for (const bad of ['../x', '../../escaped', 'a/b', 'has space', '', 'under_score.router.test', 'x'.repeat(254)]) {
    expect(findCertFiles(certDir, bad), bad).toBeNull()
    expect(await certs.certFor(bad), bad).toBeNull()
  }
  // A malformed name never even asks the edge to issue for it.
  expect(issued).toEqual([])
})

test('sniCallback hands the default context to a servername the route table does not serve, and reads no store', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
  const host = 'api.router.test'
  mkdirSync(join(certDir, 'local', host), { recursive: true })
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', host, `${host}.crt`))
  cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', host, `${host}.key`))
  const issued: string[] = []
  const certs = new Certs({ certDir, issue: async (h) => { issued.push(h) } })
  const fallback = await certs.certFor(host)
  expect(fallback).not.toBeNull()

  const owned = new Set([host])
  const cb = certs.sniCallback(fallback, (h) => owned.has(h))
  const ask = (servername: string): Promise<unknown> =>
    new Promise((resolve, reject) => cb(servername, (e, ctx) => (e ? reject(e) : resolve(ctx))))

  // Case and a trailing dot still reach the store: Caddy may send either.
  expect(await ask('API.router.test.')).toBe(fallback)
  expect(issued).toEqual([])
  // A name nobody serves gets the default context and buys no issuance handshake and no walk.
  expect(await ask('scan-1.example.com')).toBe(fallback)
  expect(await ask('scan-2.example.com')).toBe(fallback)
  expect(issued).toEqual([])
})

test('a name under the bucket suffix that no bucket owns is refused for certificate work, a registered host is not', async () => {
  const cfg = serverConfig()
  const state: State = {
    ...EMPTY,
    projects: { p1: project() },
    branches: {
      b1: branch({
        databases: { 'pg-db': { url: 'postgres://x', container: 'io-demo-main-pg-db' } },
        buckets: { 'st-store': { bucket: 'io-demo-main-store', env: {} } },
      }),
    },
  }
  const h = await harness(cfg, state)
  const dbHost = 'pg-db-demo-main.example.test'
  const bucketHost = 'io-demo-main-store.s3.example.test'
  const stranger = 'not-a-bucket.s3.example.test'
  try {
    // Routing still matches ANY single label under the suffix: the object store answers its own 404.
    expect(h.router.table().byHost(stranger)?.kind).toBe('garage-vhost')
    // Ownership does not, and ownership is what authorizes certificate work.
    expect(h.router.ownsHostname(stranger)).toBe(false)
    expect(h.router.ownsHostname(bucketHost)).toBe(true)
    expect(h.router.ownsHostname(dbHost)).toBe(true)
    expect(h.router.ownsHostname(`api.${cfg.domain}`)).toBe(true)
    expect(h.router.ownsHostname('nothing.example.test')).toBe(false)

    // The predicate the database lanes hand to Certs is this one, so a stranger arriving as a TLS
    // servername on the public pg/redis/mongo ports reads no store and buys no issuance handshake.
    const certDir = mkdtempSync(join(tmpdir(), 'io-certs-'))
    mkdirSync(join(certDir, 'local', dbHost), { recursive: true })
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.crt'), join(certDir, 'local', dbHost, `${dbHost}.crt`))
    cpSync(join('test', 'fixtures', 'local', 'router.test', 'router.test.key'), join(certDir, 'local', dbHost, `${dbHost}.key`))
    const issued: string[] = []
    const certs = new Certs({ certDir, issue: async (x) => { issued.push(x) } })
    const cb = certs.sniCallback(null, (x) => h.router.ownsHostname(x))
    const ask = (servername: string): Promise<unknown> =>
      new Promise((resolve, reject) => cb(servername, (e, ctx) => (e ? reject(e) : resolve(ctx))))

    expect(await ask(stranger)).toBeUndefined()
    expect(await ask('anything.s3.example.test')).toBeUndefined()
    expect(issued).toEqual([])
    // A hostname the box really serves still gets its certificate.
    expect(await ask(dbHost)).toBeDefined()
    expect(issued).toEqual([])
  } finally {
    await h.close()
  }
})

// ---- write classes: what actually rebuilds the table --------------------------------------------

test('an audit event does not rebuild the route table; a real service change does', async () => {
  const cfg = testConfig()
  const engine = makeEngine(cfg)
  const { project } = await engine.createProject('demo')
  // No `table` seam: this Router builds from the real state file, memoized on the routing revision.
  const router = new Router({
    cfg, stateOf: () => 'running', wake: async () => { /* nothing sleeps here */ },
    touch: () => { /* no scheduler */ }, beginHold: () => { /* idem */ }, endHold: () => { /* idem */ },
    upstream: new FakeUpstream(), log: () => { /* quiet */ },
  })
  try {
    const before = router.table()
    // Secrets reads, storage object activity, template progress and every sleep or wake come
    // through emit. None of them changes a route, so none of them may cost a table rebuild.
    engine.emit(project.id, 'main', 'agent', 'secret.read', { name: 'API_KEY' })
    expect(router.table()).toBe(before)
    // The event still landed: this is an audit-class write, not a skipped one.
    expect(engine.listEvents(project.id).map((e) => e.kind)).toContain('secret.read')
    // A routing-class write is the thing that must invalidate.
    await engine.createProject('other')
    const after = router.table()
    expect(after).not.toBe(before)
    expect(after.byHost(`api.${cfg.domain}`)).toBeDefined()
  } finally {
    await router.stop()
  }
})
