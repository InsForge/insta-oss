#!/usr/bin/env python3
import io, sys

path = 'test/router.test.ts'
with io.open(path, encoding='utf-8') as f:
    txt = f.read()

old = """    upstream: fake, signal: ctrl.signal, secureContext: defaultCtx, sniCallback: certs.sniCallback(defaultCtx),
    log: () => { /* quiet */ },
  }, 'redis', '127.0.0.1', 0)
  const port = await listenEphemeral(lane)
"""
new = """    upstream: fake, signal: ctrl.signal, defaultMaterial: certs.materialFor('api.router.test'), sniCallback: certs.sniCallback(defaultCtx),
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
"""
if new in txt:
    print('already applied')
else:
    assert txt.count(old) == 1, 'anchor: %d' % txt.count(old)
    txt = txt.replace(old, new, 1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt)
    print('patched', path)
