// Certificates for the TLS lanes, read from the edge's store (decision 21; 02 section 8). The daemon
// never runs openssl and never mints a certificate: Caddy's on-demand issuance is triggered by a
// TLS handshake to the edge with the wanted servername, then the store is re-read. Layout is
// Caddy's: `<certDir>/<issuer>/<host>/<host>.crt` and `.key`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
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

/** What a SUPPLIED certificate has left, or null when there is none to read.
 *
 *  `--tls custom` is the only mode where a certificate is not renewed by whatever issued it, so
 *  it is the only mode with a failure nobody is told about: the certificate expires and browsers
 *  and `psql` are the first to say so. This cannot renew it, and it deliberately does not try.
 *  What it can do is make the number visible -- so `healthz` carries it unconditionally and a
 *  monitor can alert on whatever margin that operator wants, rather than on one we picked. */
export interface SuppliedCert { path: string; notAfter: string; secondsLeft: number; daysLeft: number }

/** Days at which the daemon starts saying so on its own. Three weeks is the useful margin for a
 *  90-day certificate; an operator with a one-year corporate wildcard reads the number out of
 *  `healthz` and picks their own. */
export const CERT_WARN_DAYS = 21

export function suppliedCert(certFile: string | null, now = Date.now()): SuppliedCert | null {
  if (!certFile) return null
  try {
    const validTo = new X509Certificate(readFileSync(certFile)).validTo
    const at = Date.parse(validTo)
    if (!Number.isFinite(at)) return null
    const secondsLeft = Math.round((at - now) / 1000)
    return { path: certFile, notAfter: new Date(at).toISOString(), secondsLeft, daysLeft: Math.floor(secondsLeft / 86_400) }
  } catch {
    return null
  }
}

/** How often the same expiry warning may be repeated. The daemon says it once per boot and then
 *  at most this often: a warning that repeats every sweep is tens of thousands of identical lines
 *  between the day it starts and the day the certificate is replaced, which is a log nobody reads
 *  and therefore a warning nobody sees. */
export const WARN_EVERY_MS = 6 * 60 * 60 * 1000

/** One line, at boot and on the sweep's beat, when a supplied certificate is close to its end or
 *  past it. Answers whether anything was said, so a caller can rate-limit it. */
export function warnExpiring(cert: SuppliedCert | null, log: (m: string) => void = (m) => console.warn(m)): boolean {
  if (!cert) return false
  if (cert.secondsLeft <= 0) {
    log(`the TLS certificate ${cert.path} EXPIRED on ${cert.notAfter}: every browser and psql client is now refusing this box. Replace both files and restart the edge (docker compose -f /etc/instacloud/compose.yml restart edge)`)
    return true
  }
  if (cert.daysLeft <= CERT_WARN_DAYS) {
    log(`the TLS certificate ${cert.path} expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'} (${cert.notAfter}). Nothing renews a supplied certificate: replace both files and restart the edge`)
    return true
  }
  return false
}

/** The operator's certificate and key, or null unless BOTH are configured. One place, because
 *  three callers ask the same question -- the lanes (which serve it), `/healthz` (which reports
 *  its expiry) and `domainCertOk` (which asks whether it covers a custom domain) -- and half a
 *  configuration must not look like a supplied certificate to any of them. */
export function suppliedFiles(cfg: Config): { crt: string; key: string } | null {
  return cfg.tls.certFile && cfg.tls.keyFile ? { crt: cfg.tls.certFile, key: cfg.tls.keyFile } : null
}

/** The supplied certificate as `/healthz` serves it: read on a TIMER, answered from memory.
 *
 *  `/healthz` is unauthenticated and public, and load balancers, monitors, the installer's own
 *  wait loop and (measured on a live box) credential scanners poll it continuously. A
 *  `readFileSync` per request is then a handle anyone can pull on to stall the event loop, and a
 *  slow or remote mount makes each read arbitrarily long: the same class as the pre-auth
 *  database-lane denial of service this project closed once already, reintroduced through a
 *  health check. So the FILE READ happens on the daemon's own beat and the request does
 *  arithmetic on a cached `notAfter`, which costs nothing per hit however fast the polling is.
 *
 *  The clock is still live: `current()` recomputes what is left every time it is asked, so a
 *  cached read never serves a stale day count. And a value is dropped whenever the file cannot
 *  be read, because "absent when the file cannot be read" has to survive a file that was
 *  readable and stopped being readable.
 *
 *  Invalidation is BY CHANGE, not by time. A cache refreshed only on a beat reports the old
 *  certificate for as long as the beat is wide, and it is wrong in the reassuring direction: a
 *  renewal from 29 days to 90 keeps reading 29, on the one field whose whole purpose is to warn
 *  before an expiry. Measured on a live box after a real rename. So every read `stat`s the path
 *  and re-parses the PEM only when the file has moved (mtime, size or inode): a stat per poll is
 *  not the blocking read this cache exists to remove, and there is no window in which the answer
 *  is stale. */
export class SuppliedCertWatch {
  private cached: { path: string; notAfterMs: number } | null = null
  private stamp: string | null = null
  private lastWarnAt = 0
  private readonly read: (path: string, now: number) => SuppliedCert | null
  private readonly log: (m: string) => void

  constructor(
    /** The CERTIFICATE of a complete pair. Callers pass null unless both halves are configured:
     *  with only one, the router serves no supplied certificate and issues per hostname, and a
     *  watch reporting one would describe a box that is doing the opposite. */
    private readonly certFile: string | null,
    opts: { read?: (path: string, now: number) => SuppliedCert | null; log?: (m: string) => void } = {},
  ) {
    this.read = opts.read ?? ((path, now) => suppliedCert(path, now))
    this.log = opts.log ?? ((m) => console.warn(m))
    this.refresh()
  }

  /** Re-read unconditionally. The daemon's beat calls this; a request does not need it. */
  refresh(now = Date.now()): void {
    this.stamp = null
    this.sync(now)
  }

  /** One `stat`. The PEM is parsed again only when the file behind the path has changed, which
   *  is what a renewal does: write alongside, rename over. */
  private sync(now: number): void {
    if (!this.certFile) { this.cached = null; this.stamp = null; return }
    let stamp: string | null = null
    try {
      const st = statSync(this.certFile)
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      // Gone or unreadable: the old value goes with it. A certificate nobody can read is not a
      // certificate with 172 days left.
      this.cached = null
      this.stamp = null
      return
    }
    if (stamp === this.stamp && this.cached) return
    this.stamp = stamp
    const cert = this.read(this.certFile, now)
    this.cached = cert ? { path: cert.path, notAfterMs: Date.parse(cert.notAfter) } : null
  }

  /** What is left, from memory: NO I/O, not even a stat.
   *
   *  `/healthz` is unauthenticated and a scanner can drive it as fast as it likes, so the
   *  request path does arithmetic and nothing else -- a `statSync` per hit is smaller than a
   *  `readFileSync` per hit and is still a syscall an anonymous caller controls the rate of.
   *  `refresh()` is what looks at the file, on the daemon's beat, so a renewal shows up here
   *  within one sweep interval (30 s by default) rather than instantly. That bound is the trade
   *  for the endpoint costing nothing, and it is documented where the renewal procedure is. */
  current(now = Date.now()): SuppliedCert | null {
    if (!this.cached) return null
    const secondsLeft = Math.round((this.cached.notAfterMs - now) / 1000)
    return {
      path: this.cached.path,
      notAfter: new Date(this.cached.notAfterMs).toISOString(),
      secondsLeft,
      daysLeft: Math.floor(secondsLeft / 86_400),
    }
  }

  /** The warning, at most once per `WARN_EVERY_MS`, and always once per boot. `warnExpiring`'s
   *  answer is what stamps the limiter, so a beat that had nothing to say does not start the
   *  clock and the first beat that does say something is not swallowed. */
  maybeWarn(now = Date.now()): boolean {
    if (this.lastWarnAt !== 0 && now - this.lastWarnAt < WARN_EVERY_MS) return false
    const said = warnExpiring(this.current(now), this.log)
    if (said) this.lastWarnAt = now
    return said
  }
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
