// Single-tenant state: one JSON file (<dataDir>/state.json; main.ts calls initStatePath(cfg.statePath),
// INSTA_OSS_STATE stays the fallback for processes that never do). Final export list per contract 00
// section 5; today's bodies where behaviour exists, stubs elsewhere (WP1 fills the rest).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** emit keeps the newest EVENTS_CAP events (decision 54); WP1 enforces it in saveState. */
export const EVENTS_CAP = 5000

const EMPTY: State = { projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {}, rev: 0, auditRev: 0, customDomains: {}, templateDeployments: {} }

let statePathOverride: string | null = null
const subscribers: Array<(s: State, kind: 'routing' | 'audit') => void> = []

/** main.ts, --reset-admin, and test/fakes.ts resetFakes()/makeEngine() call it before the first loadState; INSTA_OSS_STATE env stays the fallback. */
export function initStatePath(p: string): void { statePathOverride = p }
export function statePath(): string { return statePathOverride ?? process.env.INSTA_OSS_STATE ?? join(homedir(), '.insta-oss', 'state.json') }

export function loadState(): State {
  const p = statePath()
  if (!existsSync(p)) return structuredClone(EMPTY)
  return migrateState({ ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(p, 'utf8')) as State) })
}

/** Current rev (WP1: stat-keyed, no clone; the scaffold body reads the file). */
export function stateRev(): number { return loadState().rev }

/** Called after every saveState; the router subscribes to rebuild its table and reconcile listeners. */
export function onSave(cb: (s: State, kind: 'routing' | 'audit') => void): void { subscribers.push(cb) }

/** WP1: tmp + rename; the scaffold body is today's plain write plus the rev bump. */
export function saveState(s: State, opts: { audit?: boolean } = {}): void {
  const kind: 'routing' | 'audit' = opts.audit ? 'audit' : 'routing'
  if (opts.audit) s.auditRev = (s.auditRev ?? 0) + 1
  else s.rev = (s.rev ?? 0) + 1
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(s, null, 2))
  for (const cb of subscribers) cb(s, kind)
}

/** Read-modify-write helper so callers never hold stale copies. Callbacks are synchronous. */
export function mutate<T>(fn: (s: State) => T, opts: { audit?: boolean } = {}): T {
  const s = loadState()
  const out = fn(s)
  if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
    throw new Error('mutate() callbacks must be synchronous: read state, decide, write; await outside')
  }
  saveState(s, opts)
  return out
}

// WP1 fills these bodies (it rewrites this file; the region pair above is its marker).
/** WP1: <dataDir>/instad.lock heartbeat (20 s utimes, stale at 60 s); a fresh lock is retried for up to 60 s. Scaffold: no-op. */
export function acquireLock(_dataDir: string): void { /* WP1 */ }
export function releaseLock(): void { /* WP1 */ }
/** WP1: coalesced 30 s buffer for low-rate audit fields (token lastUsedAt, session slide); flushes with { audit: true }. Scaffold: applies immediately. */
export function touchLater(fn: (s: State) => void): void { mutate(fn, { audit: true }) }

// ---- region WP5 (templates/parity) ----
/** WP5: pure; legacy dbUrl/bucket/s3/storagePublic -> dbServices/storageServices/databases/buckets. Scaffold: identity. */
export function migrateState(s: State): State { return s }
// ---- end region WP5 ----
