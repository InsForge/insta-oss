// Single-tenant state: one JSON file (<dataDir>/state.json; main.ts calls initStatePath(cfg.statePath),
// INSTA_OSS_STATE stays the fallback for processes that never do). Contract 00 section 5:
//   - every write is tmp + rename (a crash never leaves a half-written state.json);
//   - reads go through a stat-keyed parse cache, so loadState() is one statSync plus a clone and
//     stateRev() is one statSync and NO clone (the router keys its table cache on it);
//   - two write classes: routing (default, bumps `rev`) and audit (`{ audit: true }`, bumps
//     `auditRev` only: emit, touchLater, markSlept; the router never rebuilds for those);
//   - `events` is trimmed to the newest EVENTS_CAP rows on every save;
//   - one daemon per data dir: <dataDir>/instad.lock with a 20 s heartbeat, stale at 60 s, and a
//     fresh lock retried for up to 60 s (the container-restart case: the previous instad was
//     SIGKILLed and its heartbeat is still under 60 s old);
//   - touchLater() coalesces low-rate audit fields (token lastUsedAt, session slide) into one
//     write every 30 s; releaseLock() and initStatePath() flush it.
// Activity stamps, in-flight markers, RSS samples, rate-limiter buckets and wake singleflight maps
// never touch this file.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project, Branch, Approval, AuditEvent, GatedAction, Decision, UserSecret, CustomDomainEntry, TemplateDeploymentRecord } from './types'

// ---- region WP1 (identity/config) ----
export interface IdentityState {
  admin: { id: string; email: string; name: string; passwordHash: string; createdAt: string; updatedAt: string } | null
  previousAdminId?: string
  sessions: Array<{ id: string; tokenHash: string; userId: string; createdAt: string; updatedAt: string; expiresAt: string; ipAddress: string; userAgent: string }>
  tokens: Array<{ id: string; name: string; prefix: 'insta_'; keyHash: string; orgId: null; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }>
}
export const EMPTY_IDENTITY: IdentityState = { admin: null, sessions: [], tokens: [] }
// ---- end region WP1 ----

export interface State {
  projects: Record<string, Project>
  branches: Record<string, Branch> // keyed by branch id
  policies: Record<string, Partial<Record<GatedAction, Decision>>> // per project
  approvals: Approval[]
  events: AuditEvent[]
  userSecrets: Record<string, UserSecret[]> // per project id
  identity?: IdentityState                                   // WP1: absent in local mode and before setup
  rev: number                                                // WP2: bumped by every ROUTING-class saveState (router table cache key; decision 54)
  auditRev: number                                           // WP1: bumped by audit-class writes (emit, touchLater, markSlept); the router ignores it
  // ---- region WP2 (router) ----
  customDomains: Record<string, CustomDomainEntry>           // key = normalized hostname
  laneReservations?: Record<string, string>                  // lane port -> branchId, written synchronously by allocLanes before provisioning awaits; released by compensation, superseded by branch.lanes (decision 51)
  // ---- end region WP2 ----
  // ---- region WP5 (templates/parity) ----
  templateDeployments: Record<string, TemplateDeploymentRecord>
  // ---- end region WP5 ----
}

/** saveState keeps the newest EVENTS_CAP events (decision 54). */
export const EVENTS_CAP = 5000
/** touchLater() flushes its buffer at this cadence (unref'd, so it never holds the process open). */
export const TOUCH_FLUSH_MS = 30_000

type SaveKind = 'routing' | 'audit'
type StatKey = { ino: number; mtimeMs: number; size: number }

const EMPTY: State = { projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {}, rev: 0, auditRev: 0, customDomains: {}, templateDeployments: {} }

let statePathOverride: string | null = null
const subscribers: Array<(s: State, kind: SaveKind) => void> = []
/** The parsed document for `path` as of `key`. Callers get clones (loadState) or scalars (stateRev), never this object. */
let cache: { path: string; key: StatKey; doc: State } | null = null
let tmpSeq = 0

/** main.ts, --reset-admin, and test/fakes.ts resetFakes()/makeEngine() call it before the first loadState; INSTA_OSS_STATE env stays the fallback. Pending touchLater writes belong to the previous file and are flushed there first. */
export function initStatePath(p: string): void {
  if (statePathOverride === p) return
  try { flushTouchLater() } catch { /* the previous file's directory is gone; those audit fields are lost with it */ }
  statePathOverride = p
  cache = null
}
export function statePath(): string { return statePathOverride ?? process.env.INSTA_OSS_STATE ?? join(homedir(), '.insta-oss', 'state.json') }

function statKey(p: string): StatKey | null {
  try { const st = statSync(p); return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
const sameKey = (a: StatKey, b: StatKey): boolean => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size

/** What a fresh read of the file yields: parsed JSON over the empty shape, then migrateState (WP5). */
function parseDoc(json: string): State {
  return migrateState({ ...structuredClone(EMPTY), ...(JSON.parse(json) as Partial<State>) })
}

/** The cached document for the current path, re-parsed when the file changed on disk; null when there is no file yet. */
function current(): State | null {
  const p = statePath()
  const key = statKey(p)
  if (!key) { cache = null; return null }
  if (cache && cache.path === p && sameKey(cache.key, key)) return cache.doc
  const doc = parseDoc(readFileSync(p, 'utf8'))
  cache = { path: p, key, doc }
  return doc
}

/** A clone of the current state (stat-keyed parse cache underneath). Never on the router's request path: it uses stateRev() plus Route fields. */
export function loadState(): State { return structuredClone(current() ?? EMPTY) }

/** Current routing rev WITHOUT cloning (one statSync on a cache hit); the router's table cache key. */
export function stateRev(): number { return current()?.rev ?? 0 }

/** Called after every saveState with the saved document and its class; the router subscribes to rebuild its table on 'routing' saves. */
export function onSave(cb: (s: State, kind: SaveKind) => void): void { subscribers.push(cb) }

/** tmp + rename; bumps rev (default) or auditRev (`{ audit: true }`); trims events to EVENTS_CAP; refreshes the parse cache; notifies subscribers. */
export function saveState(s: State, opts: { audit?: boolean } = {}): void {
  const kind: SaveKind = opts.audit ? 'audit' : 'routing'
  if (opts.audit) s.auditRev = (s.auditRev ?? 0) + 1
  else s.rev = (s.rev ?? 0) + 1
  if (Array.isArray(s.events) && s.events.length > EVENTS_CAP) s.events = s.events.slice(-EVENTS_CAP)
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  const json = JSON.stringify(s, null, 2)
  const tmp = `${p}.tmp-${process.pid}-${++tmpSeq}`
  writeFileSync(tmp, json)
  renameSync(tmp, p)
  const key = statKey(p)
  cache = key ? { path: p, key, doc: parseDoc(json) } : null
  for (const cb of subscribers) cb(s, kind)
}

const isThenable = (v: unknown): boolean => v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function'

/** Read-modify-write helper so callers never hold stale copies. Callbacks are synchronous: an async callback throws BEFORE anything is written. */
export function mutate<T>(fn: (s: State) => T, opts: { audit?: boolean } = {}): T {
  const s = loadState()
  const out = fn(s)
  if (isThenable(out)) throw new Error('mutate() callbacks must be synchronous: read state, decide, write; await outside')
  saveState(s, opts)
  return out
}

// ---- process lock: one instad per data dir ----

export interface LockOptions {
  staleMs?: number      // a heartbeat older than this is a dead holder (default 60 s)
  retryMs?: number      // wait between attempts on a fresh lock (default 2 s)
  timeoutMs?: number    // give up on a fresh lock after this long (default 60 s; 0 = one attempt)
  heartbeatMs?: number  // utimes cadence once held (default 20 s; 0 = none)
  sleep?: (ms: number) => void   // tests inject; the default blocks the thread (boot is synchronous here)
}

let held: { path: string; bootId: string; timer: NodeJS.Timeout | null } | null = null

function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readHolder(lockPath: string): { pid?: number; bootId?: string; startedAt?: string; host?: string } {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; bootId?: string; startedAt?: string; host?: string } }
  catch { return {} }
}

/** <dataDir>/instad.lock: created with O_EXCL and heartbeat-touched every 20 s. A lock whose heartbeat is older than 60 s is taken over; a fresh one is retried every 2 s for up to 60 s (the previous container was SIGKILLed and its heartbeat has not aged out yet) before throwing with the holder's pid. Throws immediately when this process already holds a lock. */
export function acquireLock(dataDir: string, opts: LockOptions = {}): void {
  const staleMs = opts.staleMs ?? 60_000
  const retryMs = opts.retryMs ?? 2_000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const heartbeatMs = opts.heartbeatMs ?? 20_000
  const sleep = opts.sleep ?? sleepSync
  const lockPath = join(dataDir, 'instad.lock')
  if (held) throw new Error(`lock already held by this process (${held.path})`)
  mkdirSync(dataDir, { recursive: true })
  const bootId = randomUUID()
  const body = JSON.stringify({ pid: process.pid, bootId, startedAt: new Date().toISOString(), host: hostname() })
  const deadline = Date.now() + timeoutMs
  let staleTakeovers = 0
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try { writeSync(fd, body) } finally { closeSync(fd) }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const key = statKey(lockPath)
    if (key === null) continue // vanished between the open and the stat: the holder just released it
    if (Date.now() - key.mtimeMs > staleMs) {
      try { unlinkSync(lockPath) } catch { /* someone else removed it first */ }
      if (++staleTakeovers <= 1) continue
    }
    if (Date.now() >= deadline) {
      const h = readHolder(lockPath)
      throw new Error(`another instad (pid ${h.pid ?? 'unknown'}, started ${h.startedAt ?? 'unknown'}) holds ${dataDir}; stop it or point INSTA_OSS_DATA_DIR elsewhere`)
    }
    sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }
  let timer: NodeJS.Timeout | null = null
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      const now = new Date()
      try { utimesSync(lockPath, now, now) } catch { /* the data dir is gone; nothing to heartbeat */ }
    }, heartbeatMs)
    timer.unref()
  }
  held = { path: lockPath, bootId, timer }
}

/** Stop the heartbeat, flush touchLater, and remove the lock only if it still carries our bootId. Safe to call twice and without a lock (it still flushes). */
export function releaseLock(): void {
  try { flushTouchLater() } catch { /* best effort at exit */ }
  const h = held
  if (!h) return
  held = null
  if (h.timer) clearInterval(h.timer)
  try { if (readHolder(h.path).bootId === h.bootId) unlinkSync(h.path) }
  catch { /* already gone */ }
}

// ---- coalesced audit writes ----

const touchBuffer: Array<(s: State) => void> = []
let touchTimer: NodeJS.Timeout | null = null

/** Queue a low-rate audit-class edit (token lastUsedAt, session slide). Buffered callbacks run inside ONE mutate(..., { audit: true }) every TOUCH_FLUSH_MS; they must look rows up by id, never through captured references. */
export function touchLater(fn: (s: State) => void): void {
  touchBuffer.push(fn)
  if (!touchTimer) {
    touchTimer = setInterval(flushTouchLater, TOUCH_FLUSH_MS)
    touchTimer.unref()
  }
}

/** Apply every queued touchLater callback now (one audit-class write); no-op when nothing is queued. */
export function flushTouchLater(): void {
  if (touchBuffer.length === 0) return
  const fns = touchBuffer.splice(0)
  mutate((s) => { for (const f of fns) f(s) }, { audit: true })
}

// ---- region WP5 (templates/parity) ----
/** WP5: pure; legacy dbUrl/bucket/s3/storagePublic -> dbServices/storageServices/databases/buckets. Scaffold: identity. */
export function migrateState(s: State): State { return s }
// ---- end region WP5 ----
