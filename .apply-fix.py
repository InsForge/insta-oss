#!/usr/bin/env python3
"""Re-apply the default-TLS-context fix in one pass (the worktree is shared, so the edits must land
together and be committed straight away)."""
import io, sys

def sub(path, old, new, count=1):
    with io.open(path, encoding='utf-8') as f:
        txt = f.read()
    if new in txt:
        print('already applied:', path)
        return
    n = txt.count(old)
    if n != count:
        print('MISS %s: found %d of %d' % (path, n, count))
        sys.exit(1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt.replace(old, new, count))
    print('patched:', path)


# ---- certs.ts: raw material for setSecureContext + a lazy fallback -------------------------------
sub('src/router/certs.ts',
"""  /** True when the store holds a certificate for `host` (no issuance attempt). */
  certExists(host: string): boolean {
    return this.certDir !== null && findCertFiles(this.certDir, host) !== null
  }
""",
"""  /** True when the store holds a certificate for `host` (no issuance attempt). */
  certExists(host: string): boolean {
    return this.certDir !== null && findCertFiles(this.certDir, host) !== null
  }

  /** The bytes behind a stored certificate, for `tls.Server.setSecureContext` on a lane that is
   *  already listening. No issuance attempt: the caller has just had one from `certFor`. */
  materialFor(host: string): { cert: Buffer; key: Buffer } | null {
    if (!this.certDir) return null
    const files = findCertFiles(this.certDir, host)
    if (!files) return null
    try { return { cert: readFileSync(files.crt), key: readFileSync(files.key) } } catch { return null }
  }
""")

sub('src/router/certs.ts',
"""  sniCallback(fallback: SecureContext | null, owns?: (host: string) => boolean): (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void {
    return (servername, cb) => {
      const host = String(servername ?? '').toLowerCase().replace(/\\.$/, '')
      if (owns && !owns(host)) { cb(null, fallback ?? undefined); return }
      this.certFor(host).then(
        (ctx) => cb(null, ctx ?? fallback ?? undefined),
        (e) => cb(e instanceof Error ? e : new Error(String(e))),
      )
    }
  }""",
"""  sniCallback(fallback: SecureContext | null | (() => SecureContext | null), owns?: (host: string) => boolean): (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void {
    // A function reads the router's CURRENT default. The lanes are built before the edge has issued
    // `api.<domain>`, so a context captured here would stay null for the life of the process.
    const fb = (): SecureContext | undefined => (typeof fallback === 'function' ? fallback() : fallback) ?? undefined
    return (servername, cb) => {
      const host = String(servername ?? '').toLowerCase().replace(/\\.$/, '')
      if (owns && !owns(host)) { cb(null, fb()); return }
      this.certFor(host).then(
        (ctx) => cb(null, ctx ?? fb()),
        (e) => cb(e instanceof Error ? e : new Error(String(e))),
      )
    }
  }""")

# ---- pg.ts: read the default context per connection ---------------------------------------------
sub('src/router/pg.ts',
"""  /** Server mode only: the per-host contexts from the edge's store plus the always-present default. */
  secureContext?: SecureContext | null""",
"""  /** Server mode only: the context for a client that sends no SNI, read per connection so a
   *  certificate the edge issues after the lane is listening needs no restart. */
  secureContext?: () => SecureContext | null""")

sub('src/router/pg.ts',
"""      // The default context is `api.<domain>`, which the installer's first request always creates:
      // a client that sends no SNI still completes the handshake and can be told why (decision 21).
      secureContext: deps.secureContext ?? undefined,""",
"""      // The default context is `api.<domain>`, which the installer's first request creates: a client
      // that sends no SNI still completes the handshake and can be told why (decision 21). Read per
      // connection, because the router starts before the edge has issued anything.
      secureContext: deps.secureContext?.() ?? undefined,""")

# ---- tls.ts: say who keeps the default context up to date ---------------------------------------
sub('src/router/tls.ts',
"""  // The default context is `api.<domain>`, present from install time, so a client with no SNI
  // completes the handshake and gets a close instead of an opaque handshake failure (decision 21).""",
"""  // The default context is `api.<domain>`, so a client with no SNI completes the handshake and gets
  // a close instead of an opaque handshake failure (decision 21). `tls.Server` reads it once, so the
  // Router pushes a later certificate in with `setSecureContext` (refreshDefaultContext).""")

# ---- index.ts -----------------------------------------------------------------------------------
sub('src/router/index.ts',
"import type { SecureContext } from 'node:tls'",
"import type { SecureContext, Server as TlsServer } from 'node:tls'")

sub('src/router/index.ts',
"  private defaultContext: SecureContext | null = null",
"""  private defaultContext: SecureContext | null = null
  /** The SNI lanes, so a certificate that arrives after they are listening can be pushed into them. */
  private readonly tlsLanes = new Set<TlsServer>()""")

sub('src/router/index.ts',
"""    if (server) {
      // Present since install time (the installer's first `curl https://api.<domain>/healthz`), so a
      // client that sends no SNI completes the handshake and can be told what is wrong.
      this.defaultContext = await this.certs.certFor(`api.${this.cfg.domain}`)
      if (!this.defaultContext) this.log(`router: no certificate for api.${this.cfg.domain} yet; TLS lanes will refuse clients that send no SNI`)
    }""",
"""    if (server) {
      // One issuance attempt here, and `reconcile` picks the certificate up later: the daemon and the
      // edge start together, so on a fresh box the store is empty AND the edge is usually not
      // answering yet when this runs, and the installer's own first request comes later still.
      await this.refreshDefaultContext(true)
      if (!this.defaultContext) this.log(`router: no certificate for api.${this.cfg.domain} yet; until the edge issues one, a TLS lane client that sends no SNI is refused`)
    }""")

sub('src/router/index.ts',
"""    this.lanes.clear()
    if (this.internal) { this.internal.close(); this.internal = null }""",
"""    this.lanes.clear()
    this.tlsLanes.clear()
    if (this.internal) { this.internal.close(); this.internal = null }""")

sub('src/router/index.ts',
"""      signal: this.abort.signal, secureContext: this.defaultContext, sniCallback: this.certs.sniCallback(this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, this.cfg.lanes.bind, port)""",
"""      signal: this.abort.signal, secureContext: () => this.defaultContext, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, this.cfg.lanes.bind, port)""")

sub('src/router/index.ts',
"""      signal: this.abort.signal, secureContext: this.defaultContext, sniCallback: this.certs.sniCallback(this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, kind, bind, port)
    s.on('connection', (c: Socket) => this.track(c))
    return s
  }""",
"""      signal: this.abort.signal, secureContext: this.defaultContext, sniCallback: this.certs.sniCallback(() => this.defaultContext, (h) => this.table().byHost(h) !== undefined), log: this.log,
    }, kind, bind, port)
    s.on('connection', (c: Socket) => this.track(c))
    this.tlsLanes.add(s)
    s.once('close', () => this.tlsLanes.delete(s))
    return s
  }

  /** The certificate a TLS lane presents to a client that sends NO SNI. Start is only the first
   *  attempt: on a fresh box nothing has asked the edge for `api.<domain>` yet, so every reconcile
   *  looks again and the SNI lanes already listening are updated in place. Only the start attempt
   *  asks the edge to issue; a later one reads the store, so a box whose ACME is failing does not
   *  pay a 15 s handshake on every service it adds. */
  private async refreshDefaultContext(issue = false): Promise<void> {
    if (this.cfg.mode !== 'server' || this.defaultContext) return
    const host = `api.${this.cfg.domain}`
    if (!issue && !this.certs.certExists(host)) return
    const ctx = await this.certs.certFor(host)
    if (!ctx) return
    this.defaultContext = ctx
    const material = this.certs.materialFor(host)
    if (!material) return
    for (const s of this.tlsLanes) {
      try { s.setSecureContext(material) } catch { /* closing: a lane opened later gets it at creation */ }
    }
  }""")

sub('src/router/index.ts',
"""  private async reconcile(): Promise<void> {
    if (this.stopped) return""",
"""  private async reconcile(): Promise<void> {
    if (this.stopped) return
    await this.refreshDefaultContext()""")

print('done')
