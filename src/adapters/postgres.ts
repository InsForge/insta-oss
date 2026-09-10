// One Postgres container per branch database, its PGDATA on a bind mount under the data dir
// (contract 00 section 12). Handles are container names the engine passes in (`io-<ref>-pg-<name>`,
// decision 17) and are never derived here.
//
// Three things this file exists to get right:
//   - a branch fork is a FILE-LEVEL clone: CHECKPOINT the source, reflink its directory (sub-second
//     at any size), start a container on the copy and let crash recovery finish the job; a
//     filesystem without reflinks streams `pg_basebackup` over the branch network instead, and the
//     daemon never buffers a byte either way (04 section D);
//   - readiness is TCP, not the socket: the image's init-time temporary server listens on the unix
//     socket only, so a socket-only probe answers "ready" mid-initdb and the next statement dies
//     with `server closed the connection unexpectedly` (#34, decision 34);
//   - the password is minted per instance (decision 18): a lane on a public interface must never
//     carry a constant.
import { randomBytes } from 'node:crypto'
import { docker } from '../docker'
import { forkMethod, probedCapabilities, sharedDataDir } from '../datadir'
import { loadConfig } from '../config'
import { NoReflinkError } from '../types'
import type { Config } from '../config'
import type { DataDirOps, DatabaseAdapter, PgTarget, ServiceLimits } from '../types'

const DB = 'app'
const IMAGE = 'postgres:16-alpine'
const PGDATA = '/var/lib/postgresql/data'
const HBA_LINE = 'host replication all all scram-sha-256  # insta-oss basebackup'
const READY_TIMEOUT_MS = 120_000
const QUERY_DEADLINE_MS = 30_000

/** psql stderr that means "the server is not accepting connections YET", not "the query is wrong". */
const CONNECT_PHASE = [
  'server closed the connection unexpectedly',
  'Connection refused',
  'the database system is starting up',
  'is not currently accepting connections',
]
/** `docker logs` lines that mean a reflink copy caught the source mid-write: retry, then fall back. */
const TORN_COPY = /could not locate a valid checkpoint record|invalid checkpoint record|requested WAL segment .* has already been removed|database files are incompatible/

type ProvisionOpts = {
  publishLoopback?: boolean
  limits?: ServiceLimits
  /** Whether a container name (or data directory) still belongs to a live branch row. Absent means
   *  "nothing references it": the engine only provisions or forks onto a service it is creating, so
   *  anything already sitting there is an interrupted earlier attempt. */
  referenced?: (container: string) => boolean
}
type ForkOpts = ProvisionOpts & { ensureSourceRunning?: () => Promise<void> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The docker seam, the way `Scheduler` takes a `Runtime`: production is the docker CLI in
 *  `src/docker.ts`, and a test injects a stub so this adapter has coverage without a container. */
export type DockerExec = (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) => Promise<Buffer>

export class LocalPostgres implements DatabaseAdapter {
  private readonly cfg: Config
  private readonly data: DataDirOps
  private readonly exec: DockerExec
  constructor(opts: { cfg?: Config; data?: DataDirOps; docker?: DockerExec } = {}) {
    this.cfg = opts.cfg ?? loadConfig()
    this.data = opts.data ?? sharedDataDir(this.cfg)
    this.exec = opts.docker ?? docker
  }

  async provision(t: PgTarget, opts: ProvisionOpts = {}): Promise<{ url: string }> {
    await this.clearOrphan(t, opts)
    if (t.dataDir) {
      if (!(await this.data.isEmptyOrMissing(t.dataDir))) {
        throw new Error(`data directory ${t.dataDir} is not empty; refusing to initdb over an existing database`)
      }
      await this.data.ensureDir(t.dataDir, 0o700)
    }
    const password = randomBytes(24).toString('base64url')
    await this.run(t, opts, [
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${DB}`,
    ])
    await this.waitReady(t.container)
    return { url: `postgres://postgres:${password}@${t.container}:5432/${DB}` }
  }

  /** Fork = reflink clone of the source's PGDATA, or `pg_basebackup` when the filesystem cannot
   *  clone (or `INSTA_OSS_FORK` says so). The clone inherits the source's files and therefore its
   *  password, so the returned DSN is the source's with the host swapped (decision 18). */
  async fork(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts = {}): Promise<{ url: string; method: 'reflink' | 'basebackup'; ms: number }> {
    const t0 = Date.now()
    const method = forkMethod(this.cfg, probedCapabilities())
    if (method === 'reflink' && src.dataDir && dst.dataDir) {
      try {
        const ms = await this.forkByReflink(src, dst, opts, false)
        return { url: swapHost(src.url, dst.container), method: 'reflink', ms }
      } catch (e) {
        if (!(e instanceof NoReflinkError) && !(e instanceof TornCopyError)) throw e
        // `INSTA_OSS_FORK=reflink` is the operator asking to FAIL rather than copy, which is how
        // main.ts already reads it at boot when the probe says this data dir cannot clone. The
        // probe is not the last word, though: a clone can still turn out impossible (a dst on
        // another mount, a `cp -c` that exits non-zero), and falling through there would stream a
        // pg_basebackup behind their back, which is the one thing the strict setting forbids.
        if (this.cfg.data.fork === 'reflink') {
          throw new NoReflinkError(`INSTA_OSS_FORK=reflink: cannot clone ${src.container} into ${dst.dataDir} by reflink (${firstLine(e)}); refusing to fall back to pg_basebackup`)
        }
        // NoReflinkError: this filesystem cannot clone after all. TornCopyError: the copy caught the
        // source mid-write twice. Both fall through to the stream.
      }
    }
    await this.forkByBasebackup(src, dst, opts)
    return { url: swapHost(src.url, dst.container), method: 'basebackup', ms: Date.now() - t0 }
  }

  async query(container: string, sql: string): Promise<string> {
    const deadline = Date.now() + QUERY_DEADLINE_MS
    for (;;) {
      try {
        const out = await this.exec(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', DB,
          '-v', 'ON_ERROR_STOP=1', '-tAc', sql])
        return out.toString().trim()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (Date.now() >= deadline || !CONNECT_PHASE.some((m) => msg.includes(m))) throw e
        await sleep(500)
      }
    }
  }

  /** Container only, with its anonymous volumes (`-v`): the engine removes the data directory. */
  async destroy(container: string): Promise<void> {
    try { await this.exec(['rm', '-f', '-v', container]) } catch { /* already gone */ }
  }

  async rename(container: string, to: string): Promise<void> {
    await this.exec(['rename', container, to])
  }

  // ---- internals ----

  private run(t: PgTarget, opts: ProvisionOpts, env: string[]): Promise<void> { return pgRun(t, opts, env, this.exec) }

  /** An interrupted provision or fork leaves a container of the right name, or a half-written data
   *  directory, behind. Both are removed before a retry (a `branch create feat` after a daemon crash
   *  mid-fork must not fail with `name already in use`, nor clone over a partial copy). Anything a
   *  live branch row still references is left alone. */
  private async clearOrphan(t: PgTarget, opts: ProvisionOpts): Promise<void> {
    if (opts.referenced?.(t.container)) return
    if (await containerExists(t.container, this.exec)) {
      console.warn(`removing orphan from an interrupted fork: container ${t.container}`)
      await this.exec(['rm', '-f', '-v', t.container]).catch(() => { /* raced away */ })
    }
    if (t.dataDir && !(await this.data.isEmptyOrMissing(t.dataDir))) {
      console.warn(`removing orphan from an interrupted fork: ${t.dataDir}`)
      await this.data.remove(t.dataDir)
    }
  }

  /** The reflink path. Throws NoReflinkError when the filesystem cannot clone and TornCopyError when
   *  even a retried clone came out unrecoverable; the caller then streams a basebackup. */
  private async forkByReflink(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts, isRetry: boolean): Promise<number> {
    await this.clearOrphan(dst, opts)
    // A CHECKPOINT flushes the source's dirty buffers so the copy needs the least redo. A source
    // that is asleep (or stops between the check and the call) is already at rest.
    if (await isRunning(src.container, this.exec)) {
      await this.query(src.container, 'CHECKPOINT').catch(() => { /* stopped underneath us: at rest */ })
    }
    const t0 = Date.now()
    await this.data.clonePostgres(src.dataDir, dst.dataDir)
    await this.run(dst, opts, [])
    try {
      await this.waitReady(dst.container)
    } catch (e) {
      const logs = await this.exec(['logs', '--tail', '200', dst.container], { mergeStderr: true })
        .then((b) => b.toString()).catch(() => '')
      await this.exec(['rm', '-f', '-v', dst.container]).catch(() => {})
      await this.data.remove(dst.dataDir).catch(() => {})
      if (!TORN_COPY.test(logs)) throw e
      if (isRetry) throw new TornCopyError(`clone of ${src.container} did not recover: ${firstLine(e)}`)
      console.warn(`clone of ${src.container} did not recover; retrying the reflink copy once`)
      return this.forkByReflink(src, dst, opts, true)
    }
    return Date.now() - t0
  }

  /** The stream path: `pg_basebackup` inside a throwaway container on the branch network, writing
   *  straight into the destination's bind mount. Needs a RUNNING source, so a sleeping one is woken
   *  through the door the engine handed us. */
  private async forkByBasebackup(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts): Promise<void> {
    await this.clearOrphan(dst, opts)
    await opts.ensureSourceRunning?.()
    await this.waitReady(src.container)
    await this.ensureHba(src.container)
    if (dst.dataDir) await this.data.ensureDir(dst.dataDir, 0o700)
    try {
      await this.exec(['run', '--rm', '--network', src.network,
        '-v', `${dst.dataDir}:/out`,
        '-e', `PGPASSWORD=${passwordOf(src.url)}`,
        IMAGE, 'pg_basebackup', '-h', src.container, '-p', '5432', '-U', 'postgres', '-D', '/out',
        '-X', 'stream', '--checkpoint=fast', '--no-password'])
    } catch (e) {
      if (dst.dataDir) await this.data.remove(dst.dataDir).catch(() => {})
      throw new Error(`pg_basebackup failed: ${firstLine(e)}`)
    }
    await this.run(dst, opts, [])
    await this.waitReady(dst.container)
  }

  private waitReady(container: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    return pgWaitReady(container, timeoutMs, this.exec)
  }

  /** `pg_basebackup` authenticates as a replication connection, which the stock image's pg_hba.conf
   *  does not allow from another container. Appended once, idempotently, after readiness, and ONLY
   *  to a database that is about to be a basebackup source. It is password gated, so it is not an
   *  escalation, but in server mode the database lane publishes on every interface, and a database
   *  that will never be a source has no reason to let a leaked password become a physical replica. */
  private async ensureHba(container: string): Promise<void> {
    await pgAppendHba(container, this.exec)
    await this.query(container, 'select pg_reload_conf()')
  }
}

/** Raised when a reflink clone came out unrecoverable twice; the caller streams instead. */
class TornCopyError extends Error {}

/** `docker run` for a provision, a clone start, or the boot migration's re-create under the new
 *  container name. `--mount type=bind`, never `-v` (decision 56): with `-v` dockerd CREATES a
 *  missing host directory, so after a reboot where the data volume did not mount, its own
 *  `--restart unless-stopped` would run initdb on the root filesystem. With `--mount` the start
 *  fails instead. Never `--stop-signal`: the image's STOPSIGNAL is SIGINT, which is Postgres's fast
 *  shutdown (SIGTERM would be a smart shutdown that waits for clients). A non-empty bind source
 *  skips initdb, so the existing password and configuration travel with the files. */
export async function pgRun(t: PgTarget, opts: { publishLoopback?: boolean; limits?: ServiceLimits } = {}, env: string[] = [], exec: DockerExec = docker): Promise<void> {
  await exec(['run', '-d', '--restart', 'unless-stopped', '--name', t.container, '--network', t.network,
    ...env,
    // ---- args WP2 ----
    ...(opts.publishLoopback ? ['-p', '127.0.0.1::5432'] : []),
    // ---- args WP3 ----
    ...limitArgs(opts.limits),
    // ---- args WP4 ----
    ...(t.dataDir ? ['--mount', `type=bind,src=${t.dataDir},dst=${PGDATA}`] : []),
    IMAGE, '-c', 'shared_preload_libraries=pg_stat_statements'])
}

/** TCP readiness (#34): `pg_isready` over 127.0.0.1 AND one statement that must come back. The
 *  image's initdb phase runs a temporary server on the unix socket only, so this is the one probe
 *  that cannot answer "ready" too early. A container that exits ends the wait with its own logs. */
export async function pgWaitReady(container: string, timeoutMs = READY_TIMEOUT_MS, exec: DockerExec = docker): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      await exec(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', DB])
      const out = (await exec(['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', DB,
        '-tAc', 'select 1'])).toString().trim()
      // A real server answers `1`; an empty capture only happens with a stubbed docker in tests.
      if (out === '' || out.split('\n')[0].trim() === '1') return
      last = `select 1 answered ${JSON.stringify(out)}`
    } catch (e) {
      last = firstLine(e)
    }
    const status = await containerStatus(container, exec)
    if (status === 'exited' || status === 'dead' || status === null) {
      const logs = await exec(['logs', '--tail', '40', container], { mergeStderr: true })
        .then((b) => b.toString().trim()).catch(() => '')
      throw new Error(`postgres "${container}" ${status === null ? 'is gone' : 'exited'} before it became ready: ${last}\n${logs}`)
    }
    if (Date.now() >= deadline) throw new Error(`postgres "${container}" never became ready: ${last}`)
    await sleep(500)
  }
}

/** The replication line `pg_basebackup` needs, appended once. The caller reloads the config. */
export async function pgAppendHba(container: string, exec: DockerExec = docker): Promise<void> {
  const conf = `${PGDATA}/pg_hba.conf`
  await exec(['exec', container, 'sh', '-c',
    `grep -q 'insta-oss basebackup' ${conf} || echo '${HBA_LINE}' >> ${conf}`])
}

function limitArgs(limits?: ServiceLimits): string[] {
  if (!limits) return []
  return ['--cpus', String(limits.cpu), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`]
}

async function containerStatus(container: string, exec: DockerExec = docker): Promise<string | null> {
  try {
    return (await exec(['inspect', '-f', '{{.State.Status}}', container])).toString().trim()
  } catch {
    return null
  }
}

async function containerExists(container: string, exec: DockerExec = docker): Promise<boolean> {
  return (await containerStatus(container, exec)) !== null
}

async function isRunning(container: string, exec: DockerExec = docker): Promise<boolean> {
  return (await containerStatus(container, exec)) === 'running'
}

/** The clone's DSN is the source's with the host swapped: a file-level fork inherits the source's
 *  roles and passwords (decision 18). */
export function swapHost(url: string, container: string): string {
  const at = url.lastIndexOf('@')
  if (at === -1) return url
  const rest = url.slice(at + 1)
  const slash = rest.indexOf('/')
  const tail = slash === -1 ? '' : rest.slice(slash)
  return `${url.slice(0, at + 1)}${container}:5432${tail}`
}

function passwordOf(url: string): string {
  const m = /^[a-zA-Z0-9+.-]+:\/\/[^:/@]*:([^@]*)@/.exec(url)
  return m ? decodeURIComponent(m[1]) : ''
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.split('\n')[0].trim()
}
