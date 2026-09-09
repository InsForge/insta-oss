#!/usr/bin/env python3
import io, sys

path = 'test/router.test.ts'
with io.open(path, encoding='utf-8') as f:
    txt = f.read()

# 1. The pg harness now hands the lane a getter (the production wiring).
old = """    secureContext: defaultCtx,
    sniCallback: certs.sniCallback(defaultCtx),"""
new = """    secureContext: () => defaultCtx,
    sniCallback: certs.sniCallback(() => defaultCtx),"""
if new not in txt:
    assert txt.count(old) == 1, 'harness secureContext'
    txt = txt.replace(old, new, 1)

# 2. The SNI-lane harness at ~720 keeps a value: tls.Server reads it once, which is the point.

# 3. New regression test.
anchor = """test('the wire ErrorResponse encoding is what libpq parses', () => {"""
assert txt.count(anchor) == 1, 'anchor'
added = """test('the pg lane picks up the default certificate the edge issues AFTER it started listening', async () => {
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

"""
txt = txt.replace(anchor, added + anchor, 1)

if "type SecureContext" not in txt:
    txt = txt.replace("import { connect as tlsConnect } from 'node:tls'",
                      "import { connect as tlsConnect, type SecureContext } from 'node:tls'", 1)

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(txt)
print('patched', path)
