// Fake adapters + engine factory shared by every fake-adapter suite (contract 00 section 6). Every
// fake records the same strings it recorded inside test/server.test.ts before the extraction, keyed
// by the HANDLE the engine now passes (container / bucket) instead of the ref, so the existing
// assertions moved only where the contract lists them. Each WP appends recorders in its region.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, DataDirOps } from '../src/types'
import type { Config } from '../src/config'
import { loadConfig } from '../src/config'
import { Engine, type EngineOptions } from '../src/engine'
import { initStatePath } from '../src/state'

export const calls: string[] = []

// Today's fake DSN is `pg://<ref>` (asserted verbatim by the secrets tests); the ref is the postgres
// container handle minus its `io-` prefix and `-pg-db` suffix.
const refOfPg = (container: string): string => container.replace(/^io-/, '').replace(/-pg-db$/, '')

export const db: DatabaseAdapter = {
  provision: async (t) => { calls.push(`db.provision:${t.container}`); return { url: `pg://${refOfPg(t.container)}` } },
  fork: async (src, dst) => { calls.push(`db.fork:${src.container}->${dst.container}`); return { url: `pg://${refOfPg(dst.container)}`, method: 'reflink', ms: 1 } },
  // Answers the observability SQL with canned JSON (order matters: metrics SQL also mentions pg_stat_activity).
  query: async (_container, sql) => {
    calls.push(`db.query:${sql.split(/\s+/).slice(0, 3).join(' ')}`)
    if (sql.includes('drop database "ghost"')) throw new Error('database "ghost" does not exist')
    if (sql.includes('pg_ls_waldir')) return JSON.stringify({
      sizes: { databaseBytes: 9000, tablesBytes: 5000, indexesBytes: 2000, walBytes: 100 },
      tables: [{ name: 'users', liveRows: 10, dataBytes: 4096, indexBytes: 1024, seqScans: 5, idxScans: 7 }],
      vacuum: { totalDeadRows: 2, tables: [{ name: 'users', deadRows: 2, deadPct: 16.7, lastVacuum: null, xidAge: 55 }] },
      unusedIndexes: [{ name: 'idx_dead', table: 'users', sizeBytes: 512, scans: 0 }],
    })
    if (sql.includes('pg_available_extensions')) return JSON.stringify({
      available: [{ name: 'pg_stat_statements' }, { name: 'plpgsql' }, { name: 'vector' }],
      enabled: ['pg_stat_statements', 'plpgsql'],
    })
    if (sql.includes('not datistemplate')) return JSON.stringify([{ name: 'app' }, { name: 'postgres' }])
    if (sql.includes('row_to_json')) return JSON.stringify({ total: 3, active: 1, idle: 2, max: 100, db_size_bytes: 123456, deadlocks: 0, inserted: 10, updated: 5, deleted: 1, blks_hit: 90, blks_read: 10 })
    if (sql.includes('pg_stat_statements')) return JSON.stringify([{ queryId: 'q1', query: 'select 1', calls: 3, totalMs: 9, meanMs: 3, rows: 3 }])
    if (sql.includes('pg_stat_activity')) return JSON.stringify([{ pid: 42, state: 'active', durationMs: 12.5, query: 'select 1' }])
    return ''
  },
  destroy: async (container) => { calls.push(`db.destroy:${container}`) },
  rename: async (container, to) => { calls.push(`db.rename:${container}->${to}`) },
}

export const compute: ComputeAdapter = {
  supportsVolumes: true,
  deploy: async (ref, o) => {
    calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}:p=${o.port}->${o.hostPort}`)
    // Recorded separately, and only when explicitly false, so the deploy line above stays the exact
    // string the older assertions match.
    if (o.start === false) calls.push(`deploy.nostart:${ref}:${o.group}`)
    if (o.volume) calls.push(`deploy.volume:${ref}:${o.group}:${o.volume.hostPath}`)
    if (o.hostAliases?.length) calls.push(`deploy.aliases:${ref}:${o.group}:${o.hostAliases.join(',')}`)
    if (o.limits) calls.push(`deploy.limits:${ref}:${o.group}:${o.limits.cpu}/${o.limits.memoryMb}`)
    return { url: `http://localhost:${o.hostPort}` }
  },
  destroy: async (ref) => { calls.push(`compute.destroy:${ref}`) },
  start: async (ref, group) => { calls.push(`compute.start:${ref}:${group}`) },
  // graceSec is appended only when given, so today's `compute.stop:<ref>:<group>` strings still match.
  stop: async (ref, group, opts) => { calls.push(`compute.stop:${ref}:${group}${opts?.graceSec !== undefined ? `:${opts.graceSec}` : ''}`) },
  suspend: async (ref, group) => { calls.push(`compute.suspend:${ref}:${group}`) },
  rename: async (ref, from_, to) => { calls.push(`compute.rename:${ref}:${from_}->${to}`) },
  // scaffold interim only (decision 53): WP3 deletes it and makes deploy/start/stop/suspend/destroy
  // update FakeRuntime.containers so liveState reads the same store the scheduler reads
  state: async () => 'running',
}

export const storage: StorageAdapter = {
  // The bucket HANDLE is `io-<ref>-<name>` (what cloneInto/destroy/setAccess receive); the env's
  // BUCKET_NAME stays today's `io-<ref>` because the deploy/object assertions match it verbatim.
  provision: async (ref, _network, name) => { calls.push(`st.provision:${ref}:${name}`); return { bucket: `io-${ref}-${name}`, env: { BUCKET_NAME: `io-${ref}`, AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_ENDPOINT_URL_S3: 'http://io-minio:9000', AWS_REGION: 'local' } } },
  cloneInto: async (srcBucket, dstBucket) => { calls.push(`st.clone:${srcBucket}->${dstBucket}`) },
  destroy: async (bucket) => { calls.push(`st.destroy:${bucket}`) },
  setAccess: async (bucket, _network, isPublic) => { calls.push(`st.access:${bucket}:${isPublic}`) },
  listBucketObjects: async (env, o) => {
    calls.push(`st.list:${env.BUCKET_NAME}:prefix=${o.prefix ?? ''}:limit=${o.limit}`)
    return { objects: [{ key: 'a.txt', size: 3, lastModified: '2026-08-18T00:00:00Z', etag: '"x"' }], ...(o.cursor ? {} : { nextCursor: 'page2' }) }
  },
  presignObjectGet: async (env, key, disposition) => {
    calls.push(`st.presignGet:${env.BUCKET_NAME}:${key}:${disposition}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}/${key}?sig`, expiresAt: '2026-08-18T00:01:00Z' }
  },
  presignObjectPost: async (env, key, contentType, size) => {
    calls.push(`st.presignPost:${env.BUCKET_NAME}:${key}:${contentType}:${size}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}`, fields: { key, policy: 'p' }, expiresAt: '2026-08-18T00:05:00Z' }
  },
  removeObject: async (env, key) => { calls.push(`st.rm:${env.BUCKET_NAME}:${key}`) },
  removeObjects: async (env, keys) => { calls.push(`st.rmN:${env.BUCKET_NAME}:${keys.join(',')}`); return { deleted: keys.length, failed: [] } },
}

export const managed: ManagedDbAdapter = {
  provision: async (t) => { calls.push(`md.provision:${t.container}`) },
  destroy: async (container) => { calls.push(`md.destroy:${container}`) },
  rename: async (container, to) => { calls.push(`md.rename:${container}->${to}`) },
}

export const data: DataDirOps = {
  probe: async () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' }),
  ensureDir: async (path) => { calls.push(`data.ensure:${path}`) },
  clonePostgres: async (src, dst) => { calls.push(`data.clone:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
  cloneTree: async (src, dst) => { calls.push(`data.cloneTree:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
  remove: async (path) => { calls.push(`data.remove:${path}`) },
  copyFromContainerVolume: async (source, containerPath, dst) => { calls.push(`data.copyFrom:${source.container ?? source.volume}:${containerPath}->${dst}`) },
  hasPgData: async () => true,
  isEmptyOrMissing: async () => true,
}

/** A fresh local-mode Config on its own tmp data dir (scheduler ticker off). */
export function testConfig(over: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'io-cfg-'))
  return loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: dir, INSTA_OSS_STATE: join(dir, 'state.json'), INSTA_OSS_SCHEDULER: '0', ...over }, [])
}

/** Server-mode twin: example.test, auth on, a fixed secret (no file I/O). */
export function serverConfig(over: Record<string, string> = {}): Config {
  return testConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_SECRET: 's'.repeat(32), INSTA_OSS_AUTH: '1', ...over })
}

/** An Engine over the fakes; points the state module at cfg.statePath first. */
export function makeEngine(cfg: Config = testConfig(), extra: Partial<EngineOptions> = {}): Engine {
  initStatePath(cfg.statePath)
  return new Engine(db, compute, storage, managed, { cfg, data, ...extra })
}

/** Clear the recorder and start from an empty state file. */
export function resetFakes(): void {
  calls.length = 0
  initStatePath(join(mkdtempSync(join(tmpdir(), 'io-')), 'state.json'))
}

// ---- region WP1 (identity/config) ----
// ---- end region WP1 ----
// ---- region WP2 (router) ----
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
// FakeRuntime (the single fake state store), FakeUpstream, makeEngine's unstarted scheduler
// ---- end region WP3 ----
// ---- region WP4 (data dir) ----
// ---- end region WP4 ----
// ---- region WP5 (templates/parity) ----
// ---- end region WP5 ----
