#!/usr/bin/env python3
"""tls.createServer ignores a `secureContext` option, so the SNI lanes never had a default context
at all. Hand them the certificate bytes and use setSecureContext."""
import io, sys

def sub(path, old, new, count=1):
    with io.open(path, encoding='utf-8') as f:
        txt = f.read()
    if new in txt:
        print('already applied:', path); return
    n = txt.count(old)
    if n != count:
        print('MISS %s: found %d of %d' % (path, n, count)); sys.exit(1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt.replace(old, new, count))
    print('patched:', path)

# ---- tls.ts -------------------------------------------------------------------------------------
sub('src/router/tls.ts',
"""  signal: AbortSignal
  secureContext?: SecureContext | null""",
"""  signal: AbortSignal
  /** The certificate the lane presents when the ClientHello carries NO SNI, as bytes. It is not a
   *  `SecureContext`, because `tls.createServer` IGNORES a `secureContext` option: `tls.Server`
   *  builds its own default from cert/key and `setSecureContext` is the only way to replace it.
   *  Null on a box the edge has not issued `api.<domain>` for yet; the Router pushes it in later. */
  defaultMaterial?: { cert: Buffer; key: Buffer } | null""")

sub('src/router/tls.ts',
"""  // The default context is `api.<domain>`, so a client with no SNI completes the handshake and gets
  // a close instead of an opaque handshake failure (decision 21). `tls.Server` reads it once, so the
  // Router pushes a later certificate in with `setSecureContext` (refreshDefaultContext).
  const server = createServer({ secureContext: deps.secureContext ?? undefined, SNICallback: deps.sniCallback, minVersion: 'TLSv1.2' })""",
"""  // The default certificate is `api.<domain>`, so a client with no SNI completes the handshake and
  // gets a close instead of an opaque handshake failure (decision 21). It has to go in through
  // `setSecureContext`; the Router calls the same method again for a certificate that arrives after
  // the lane is already listening (refreshDefaultContext).
  const server = createServer({ SNICallback: deps.sniCallback, minVersion: 'TLSv1.2' })
  if (deps.defaultMaterial) server.setSecureContext(deps.defaultMaterial)""")

# `SecureContext` is still used by the sniCallback signature, so the import stays.

# ---- index.ts -----------------------------------------------------------------------------------
sub('src/router/index.ts',
"""  private defaultContext: SecureContext | null = null
  /** The SNI lanes, so a certificate that arrives after they are listening can be pushed into them. */
  private readonly tlsLanes = new Set<TlsServer>()""",
"""  private defaultContext: SecureContext | null = null
  /** The same certificate as bytes: what `tls.Server.setSecureContext` takes. */
  private defaultMaterial: { cert: Buffer; key: Buffer } | null = null
  /** The SNI lanes, so a certificate that arrives after they are listening can be pushed into them. */
  private readonly tlsLanes = new Set<TlsServer>()""")

sub('src/router/index.ts',
"""      signal: this.abort.signal, secureContext: this.defaultContext, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, kind, bind, port)""",
"""      signal: this.abort.signal, defaultMaterial: this.defaultMaterial, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, kind, bind, port)""")

sub('src/router/index.ts',
"""    this.defaultContext = ctx
    const material = this.certs.materialFor(host)
    if (!material) return
    for (const s of this.tlsLanes) {
      try { s.setSecureContext(material) } catch { /* closing: a lane opened later gets it at creation */ }
    }""",
"""    this.defaultContext = ctx
    const material = this.certs.materialFor(host)
    if (!material) return
    this.defaultMaterial = material
    for (const s of this.tlsLanes) {
      try { s.setSecureContext(material) } catch { /* closing: a lane opened later gets it at creation */ }
    }""")

print('done')
