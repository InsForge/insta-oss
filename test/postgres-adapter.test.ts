// src/adapters/postgres.ts over an injected docker seam (contract 00 section 14). No container
// runs here: `LocalPostgres` takes its `docker` the way `Scheduler` takes a `Runtime`, so the
// ORDER of the calls a fork makes, the readiness predicate and the replication line are all
// assertable in milliseconds. The Docker suites (fork.int, clone-isolation.int) prove the same
// paths against a real server; this file is what fails fast when the sequence changes.
import { test, expect } from 'vitest'
import { LocalPostgres, pgWaitReady, type DockerExec } from '../src/adapters/postgres'
import type { Config } from '../src/config'
import { NoReflinkError, type DataDirOps, type PgTarget } from '../src/types'
import { testConfig } from './fakes'

const HBA = 'insta-oss basebackup'

/** A docker stub that records every argv. Containers in `running` answer `docker inspect` with
 *  their status and every other name is absent (which is what a destination looks like before a
 *  fork); `selectOne` answers the readiness statement; `on` overrides any single call. */
function stubDocker(opts: { running?: string[]; status?: string; selectOne?: string; on?: (args: string[]) => string | Error | undefined } = {}): { calls: string[][]; exec: DockerExec } {
  const calls: string[][] = []
  const live = new Set(opts.running ?? [])
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    const custom = opts.on?.(args)
    if (custom instanceof Error) throw custom
    if (typeof custom === 'string') return Buffer.from(custom)
    if (args[0] === 'inspect') {
      if (!live.has(args[args.length - 1])) throw new Error('Error: No such object')
      return Buffer.from(`${opts.status ?? 'running'}\n`)
    }
    if (args.includes('select 1')) return Buffer.from(`${opts.selectOne ?? '1'}\n`)
    return Buffer.from('')
  }
  return { calls, exec }
}

/** A DataDirOps that records what the adapter asked of the filesystem. */
function stubData(over: Partial<DataDirOps> = {}): { ops: string[]; data: DataDirOps } {
  const ops: string[] = []
  const data: DataDirOps = {
    probe: async () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' }),
    ensureDir: async (path) => { ops.push(`ensureDir:${path}`) },
    clonePostgres: async (src, dst) => { ops.push(`clone:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
    cloneTree: async (src, dst) => { ops.push(`cloneTree:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
    remove: async (path) => { ops.push(`remove:${path}`) },
    copyFromContainerVolume: async () => { ops.push('copyFromVolume') },
    hasPgData: async () => true,
    isEmptyOrMissing: async () => true,
    ...over,
  }
  return { ops, data }
}

const cfgWith = (fork?: string): Config => testConfig(fork ? { INSTA_OSS_FORK: fork } : {})

const src = (over: Partial<PgTarget> = {}): PgTarget & { url: string } => ({
  container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db',
  url: 'postgres://postgres:sourcepw@io-demo-main-pg-db:5432/app', ...over,
})
const dst = (over: Partial<PgTarget> = {}): PgTarget => ({
  container: 'io-demo-feat-pg-db', network: 'io-demo-feat', dataDir: '/data/pg/demo-feat-db', ...over,
})

/** The argv of the calls, joined, so a test can talk about order without matching every flag. */
const line = (calls: string[][]): string[] => calls.map((a) => a.join(' '))
const indexOfMatch = (calls: string[][], needle: string): number => line(calls).findIndex((l) => l.includes(needle))

// ---- the replication line (host replication all all scram-sha-256) ------------------------------

test('a plain provision never writes the replication line into pg_hba.conf', async () => {
  const { calls, exec } = stubDocker()
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const { url } = await pg.provision({ container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db' })

  expect(url).toMatch(/^postgres:\/\/postgres:[^@]+@io-demo-main-pg-db:5432\/app$/)
  // The database is created and readied.
  expect(indexOfMatch(calls, 'run -d --restart unless-stopped')).toBeGreaterThanOrEqual(0)
  expect(indexOfMatch(calls, 'pg_isready')).toBeGreaterThanOrEqual(0)
  // And it is NOT told to accept replication connections. Every branch database used to get this
  // line, on a lane that server mode publishes on all interfaces, for a stream it will never serve.
  expect(line(calls).filter((l) => l.includes(HBA))).toEqual([])
  expect(line(calls).filter((l) => l.includes('pg_reload_conf'))).toEqual([])
})

test('a basebackup fork appends the replication line to the SOURCE only, before it streams', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('basebackup')

  // The append and the strip both name the marker, so tell them apart by shape.
  const appends = calls.filter((a) => a.join(' ').includes(HBA) && a.join(' ').includes('grep -q'))
  expect(appends).toHaveLength(1)
  // On the source container, and idempotent: the shell line greps before it appends.
  expect(appends[0]).toContain('io-demo-main-pg-db')
  expect(appends[0].join(' ')).toContain("grep -q 'insta-oss basebackup'")
  expect(appends[0].join(' ')).not.toContain('io-demo-feat-pg-db')
  // Before the stream, and the config is reloaded so the running server picks it up.
  expect(indexOfMatch(calls, HBA)).toBeLessThan(indexOfMatch(calls, 'pg_basebackup'))
  expect(indexOfMatch(calls, 'pg_reload_conf')).toBeLessThan(indexOfMatch(calls, 'pg_basebackup'))

  // A base backup copies pg_hba.conf, so the child would otherwise inherit the line and pass it on
  // again. It is stripped from the copy after the stream and BEFORE the child is ever started, so a
  // branch that is never a source accepts no replication connection.
  const strips = calls.filter((a) => a.join(' ').includes('sed -i') && a.join(' ').includes(HBA))
  expect(strips).toHaveLength(1)
  expect(strips[0].join(' ')).toContain('/out/pg_hba.conf')
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeLessThan(indexOfMatch(calls, 'sed -i'))
})

test('a reflink fork writes no replication line at all: nothing streams', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(line(calls).filter((l) => l.includes(HBA))).toEqual([])
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

// ---- readiness (#34): the probe that must not answer early -------------------------------------

test('readiness needs the row a live server sends: an empty answer is not ready', async () => {
  // The image's initdb phase runs a temporary server on the unix socket, so `select 1` over
  // 127.0.0.1 can come back with nothing while the real server is still starting. That is the bug
  // this probe exists for, and it stays not-ready until a `1` arrives.
  let answers = 0
  const { calls, exec } = stubDocker({
    running: ['io-demo-main-pg-db'],
    on: (args) => (args.includes('select 1') ? (answers++ < 2 ? '' : '1') : undefined),
  })
  await pgWaitReady('io-demo-main-pg-db', 10_000, exec)
  expect(answers).toBe(3)
  // Each not-ready round re-checks that the container is still alive before it sleeps.
  expect(calls.filter((a) => a[0] === 'inspect').length).toBe(2)
})

test('readiness gives up on the deadline with the last answer, and never calls it ready', async () => {
  const { exec } = stubDocker({ running: ['io-demo-main-pg-db'], selectOne: '' })
  await expect(pgWaitReady('io-demo-main-pg-db', 1, exec)).rejects.toThrow(/never became ready: select 1 answered ""/)
})

test('a container that exited during the wait ends it with its own logs', async () => {
  const { exec } = stubDocker({
    running: ['io-demo-main-pg-db'],
    status: 'exited',
    on: (args) => {
      if (args.includes('select 1')) return new Error('server closed the connection unexpectedly')
      if (args[0] === 'logs') return 'FATAL: data directory has invalid permissions'
      return undefined
    },
  })
  await expect(pgWaitReady('io-demo-main-pg-db', 10_000, exec))
    .rejects.toThrow(/exited before it became ready[\s\S]*invalid permissions/)
})

test('a plain provision waits for readiness before it hands back a DSN', async () => {
  const { calls, exec } = stubDocker()
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })
  await pg.provision({ container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db' })
  expect(indexOfMatch(calls, 'run -d')).toBeLessThan(indexOfMatch(calls, 'pg_isready'))
  expect(indexOfMatch(calls, 'pg_isready')).toBeLessThan(indexOfMatch(calls, 'select 1'))
})

test('a source that already carries the line is not asked twice in one fork', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })
  await pg.fork(src(), dst())
  await pg.fork(src(), dst({ container: 'io-demo-two-pg-db', dataDir: '/data/pg/demo-two-db' }))
  // Once per fork, always against the source, never against a destination.
  const appends = calls.filter((a) => a.join(' ').includes(HBA) && a.join(' ').includes('grep -q'))
  expect(appends).toHaveLength(2)
  for (const a of appends) expect(a).toContain('io-demo-main-pg-db')
  // And each destination is stripped, so neither child can become a source by inheritance.
  const strips = calls.filter((a) => a.join(' ').includes('sed -i') && a.join(' ').includes(HBA))
  expect(strips).toHaveLength(2)
})

// ---- fork ordering -----------------------------------------------------------------------------

test('a reflink fork checkpoints the source, then clones, then starts the copy and waits for it', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(ops).toEqual(['clone:/data/pg/demo-main-db->/data/pg/demo-feat-db'])
  // The CHECKPOINT flushes the source's dirty buffers so the copy needs the least redo, and it has
  // to happen BEFORE the clone or the copy is of the unflushed state.
  const checkpoint = indexOfMatch(calls, 'CHECKPOINT')
  expect(checkpoint).toBeGreaterThanOrEqual(0)
  expect(calls[checkpoint]).toContain('io-demo-main-pg-db')
  // Then the destination container starts on the copy and crash recovery is waited out.
  const started = indexOfMatch(calls, 'run -d --restart unless-stopped --name io-demo-feat-pg-db')
  const ready = line(calls).findIndex((l) => l.includes('pg_isready') && l.includes('io-demo-feat-pg-db'))
  expect(started).toBeGreaterThan(checkpoint)
  expect(ready).toBeGreaterThan(started)
})

test('a sleeping source is cloned as it lies: no CHECKPOINT, and the copy still starts', async () => {
  // `running: []`: the source container exists for nobody, which is what an asleep (exited) or
  // already removed source looks like to `docker inspect -f {{.State.Status}}`.
  const { calls, exec } = stubDocker()
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(indexOfMatch(calls, 'CHECKPOINT')).toBe(-1)
  expect(ops).toEqual(['clone:/data/pg/demo-main-db->/data/pg/demo-feat-db'])
})

test('a clone that comes out unrecoverable is retried exactly once, cleaning up each time', async () => {
  // A copy that caught the source mid-write says so in the container's own log, and the adapter
  // reads that rather than guessing. `INSTA_OSS_FORK=reflink` is the operator asking to FAIL
  // instead of streaming, so the second torn copy surfaces as a refusal.
  const { calls, exec } = stubDocker({
    running: ['io-demo-main-pg-db'],
    on: (args) => {
      if (args[0] === 'exec' && args[1] === 'io-demo-feat-pg-db') return new Error('pg_isready: no response')
      if (args[0] === 'logs') return 'PANIC: could not locate a valid checkpoint record'
      return undefined
    },
  })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/refusing to fall back to pg_basebackup/)
  // Two attempts, each with its half-written copy and its container taken away again.
  expect(ops.filter((o) => o.startsWith('clone:'))).toHaveLength(2)
  expect(ops.filter((o) => o === 'remove:/data/pg/demo-feat-db')).toHaveLength(2)
  // One torn-copy diagnosis read per attempt (the wait quotes its own shorter tail separately).
  expect(calls.filter((a) => a[0] === 'logs' && a[2] === '200' && a.includes('io-demo-feat-pg-db'))).toHaveLength(2)
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-feat-pg-db'))).toHaveLength(2)
  // And nothing streamed behind the operator's back.
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('INSTA_OSS_FORK=reflink on a filesystem that cannot clone fails instead of streaming', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData({ clonePostgres: async () => { throw new NoReflinkError('this filesystem cannot clone') } })
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/refusing to fall back to pg_basebackup/)
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('a basebackup fork wakes the source first, and streams straight into the destination mount', async () => {
  const woken: string[] = []
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })

  const out = await pg.fork(src(), dst(), { ensureSourceRunning: async () => { woken.push('src') } })
  expect(out.method).toBe('basebackup')
  // The stream needs a RUNNING source, so the engine's door is used before anything is read.
  expect(woken).toEqual(['src'])
  const stream = calls.find((a) => a.includes('pg_basebackup'))!
  expect(stream.join(' ')).toContain('--network io-demo-main')       // the SOURCE branch network
  expect(stream.join(' ')).toContain('-v /data/pg/demo-feat-db:/out') // no byte passes through us
  expect(stream.join(' ')).toContain('PGPASSWORD=sourcepw')
  expect(stream.join(' ')).toContain('-X stream --checkpoint=fast --no-password')
  // The destination directory exists before the stream and the copy is started afterwards.
  expect(ops).toContain('ensureDir:/data/pg/demo-feat-db')
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeLessThan(indexOfMatch(calls, '--name io-demo-feat-pg-db'))
  // The clone inherits the source's roles, so the DSN is the source's with the host swapped.
  expect(out.url).toBe('postgres://postgres:sourcepw@io-demo-feat-pg-db:5432/app')
})

test('an interrupted earlier attempt is cleared, and anything a live row still references is not', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db', 'io-demo-feat-pg-db'] })
  const { ops, data } = stubData({ isEmptyOrMissing: async () => false })
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await pg.fork(src(), dst())
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-feat-pg-db'))).toHaveLength(1)
  expect(ops[0]).toBe('remove:/data/pg/demo-feat-db')

  // A destination a live branch row still owns is never touched: the caller says so.
  const second = stubDocker({ running: ['io-demo-main-pg-db', 'io-demo-feat-pg-db'] })
  const kept = stubData({ isEmptyOrMissing: async () => false })
  const pg2 = new LocalPostgres({ cfg: cfgWith('reflink'), data: kept.data, docker: second.exec })
  await pg2.fork(src(), dst(), { referenced: () => true })
  expect(second.calls.filter((a) => a[0] === 'rm')).toEqual([])
  expect(kept.ops.filter((o) => o.startsWith('remove:'))).toEqual([])
})
