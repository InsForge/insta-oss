// Certificates for the TLS lanes, read from the edge's store (decision 21; 02 section 8). The daemon
// never runs openssl and never mints a certificate: Caddy's on-demand issuance is triggered by a
// TLS handshake to the edge with the wanted servername, then the store is re-read. Layout is
// Caddy's: `<certDir>/<issuer>/<host>/<host>.crt` and `.key`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { connect as tlsConnect, createSecureContext, type SecureContext } from 'node:tls'
import type { Config } from '../config'
import { isHostname } from './table'

export interface CertFiles { crt: string; key: string; mtimeMs: number }

/** Walk the store for an exact host match. `host` reaches here from a TLS servername, which on the
 *  three server-mode lanes arrives from anyone who can open a TCP connection to the box, so it is
 *  shape-checked before it becomes a path: without that, `..` in a servername is `..` in a read. */
export function findCertFiles(certDir: string, host: string): CertFiles | null {
  if (!isHostname(host)) return null
  let issuers: string[]
  try { issuers = readdirSync(certDir) } catch { return null }
  for (const issuer of issuers) {
    const crt = join(certDir, issuer, host, `${host}.crt`)
    const key = join(certDir, issuer, host, `${host}.key`)
    if (existsSync(crt) && existsSync(key)) {
      try { return { crt, key, mtimeMs: statSync(crt).mtimeMs } } catch { /* raced a renewal; next issuer or null */ }
    }
  }
  return null
}

/** Production issuer: a handshake to the edge with `servername` makes Caddy issue on demand (or
 *  fall back to its internal CA). Bounded at 15 s; the handshake outcome itself is irrelevant. */
export function triggerIssuance(cfg: Config): (host: string) => Promise<void> {
  return (host) => new Promise((resolve) => {
    const s = tlsConnect({ host: '127.0.0.1', port: cfg.tls.edgePort, servername: host, rejectUnauthorized: false })
    const done = (): void => { s.destroy(); resolve() }
    s.setTimeout(15_000, done)
    s.once('secureConnect', done)
    s.once('error', done)
  })
}

/** Loaded contexts held at once. One entry per hostname this box actually serves is a handful;
 *  the cap only ever bites on a scan, and evicting the oldest costs one re-read. */
const CACHE_MAX = 256

export class Certs {
  private cache = new Map<string, { ctx: SecureContext; mtimeMs: number; crt: string }>()
  private readonly certDir: string | null
  private readonly supplied: CertFiles | null
  private readonly issue: (host: string) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(opts: {
    certDir: string | null
    /** `--tls custom`: one operator-supplied pair, served for every SNI. */
    supplied?: { crt: string; key: string } | null
    issue?: (host: string) => Promise<void>
    log?: (msg: string) => void
  }) {
    this.certDir = opts.certDir
    this.supplied = opts.supplied ? { ...opts.supplied, mtimeMs: 0 } : null
    this.issue = opts.issue ?? (async () => { /* no issuer: tests and local mode */ })
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  /** The supplied pair, re-stat'ed so a replaced file is picked up without a restart. Null when
   *  no pair was supplied, or when what was supplied cannot be read: an unreadable file is not a
   *  reason to fall back to ISSUING one, which is the thing `--tls custom` exists to prevent, so
   *  the caller answers no certificate and the lane says so. */
  private suppliedFiles(): CertFiles | null {
    if (!this.supplied) return null
    try { return { ...this.supplied, mtimeMs: statSync(this.supplied.crt).mtimeMs } } catch { return null }
  }

  /** True when a certificate for `host` is available (no issuance attempt). */
  certExists(host: string): boolean {
    if (this.supplied) return this.suppliedFiles() !== null
    return this.certDir !== null && findCertFiles(this.certDir, host) !== null
  }

  /** The bytes behind a certificate, for `tls.Server.setSecureContext` on a lane that is already
   *  listening. No issuance attempt: the caller has just had one from `certFor`. */
  materialFor(host: string): { cert: Buffer; key: Buffer } | null {
    const files = this.supplied ? this.suppliedFiles() : (this.certDir ? findCertFiles(this.certDir, host) : null)
    if (!files) return null
    try { return { cert: readFileSync(files.crt), key: readFileSync(files.key) } } catch { return null }
  }

  /** The context for `host`: cached by the .crt mtime; missing -> trigger issuance once, re-walk;
   *  still missing -> null (the lane then falls back to the default context so the client completes
   *  the handshake and receives a readable error instead of an alert). */
  async certFor(host: string): Promise<SecureContext | null> {
    if (!isHostname(host)) return null
    // A supplied pair is the whole answer: it covers `*.<domain>`, it is what the edge serves,
    // and asking for issuance would be the leak this mode removes. `triggerIssuance` is a
    // handshake to the edge with the wanted servername, which is exactly what publishes a
    // hostname to certificate transparency -- so on this path the lanes were a second door to
    // the same problem, independent of what the edge was configured to do.
    if (this.supplied) {
      const files = this.suppliedFiles()
      if (!files) { this.log(`router: the supplied certificate ${this.supplied.crt} cannot be read; the lanes have no certificate to present`); return null }
      return this.contextFor(host, files)
    }
    if (!this.certDir) return null
    let files = findCertFiles(this.certDir, host)
    if (!files) {
      try { await this.issue(host) } catch (e) { this.log(`router: certificate issuance for ${host} failed: ${e instanceof Error ? e.message : String(e)}`) }
      files = findCertFiles(this.certDir, host)
    }
    if (!files) return null
    return this.contextFor(host, files)
  }

  /** One loaded context per host, cached by the .crt's mtime so a renewal or a replaced file is
   *  picked up on the next handshake. */
  private contextFor(host: string, files: CertFiles): SecureContext | null {
    const hit = this.cache.get(host)
    if (hit && hit.mtimeMs === files.mtimeMs && hit.crt === files.crt) return hit.ctx
    try {
      const ctx = createSecureContext({ cert: readFileSync(files.crt), key: readFileSync(files.key) })
      this.cache.set(host, { ctx, mtimeMs: files.mtimeMs, crt: files.crt })
      while (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      return ctx
    } catch (e) {
      this.log(`router: unreadable certificate for ${host}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** Node's SNICallback: the host's context, else `fallback` (never an alert on a missing cert).
   *  `owns` is EXPLICIT ownership (`Router.ownsHostname`, the route table's `hosts()` membership),
   *  not the wider `byHost()` routing lookup, which matches any single label under the object-store
   *  suffix. A servername ownership does not know never reaches the store: the lanes listen on
   *  0.0.0.0, and a miss costs a directory walk plus a 15 s issuance handshake, so a scanner sending
   *  fresh servernames would otherwise buy that work for the price of a packet.
   *  It stays optional because the pg lane's own tests build a Certs with no table behind it. */
  sniCallback(fallback: SecureContext | null | (() => SecureContext | null), owns?: (host: string) => boolean): (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void {
    // A function reads the router's CURRENT default. The lanes are built before the edge has issued
    // `api.<domain>`, so a context captured here would stay null for the life of the process.
    const fb = (): SecureContext | undefined => (typeof fallback === 'function' ? fallback() : fallback) ?? undefined
    return (servername, cb) => {
      const host = String(servername ?? '').toLowerCase().replace(/\.$/, '')
      if (owns && !owns(host)) { cb(null, fb()); return }
      this.certFor(host).then(
        (ctx) => cb(null, ctx ?? fb()),
        (e) => cb(e instanceof Error ? e : new Error(String(e))),
      )
    }
  }
}
