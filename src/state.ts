// Single-tenant local state: one JSON file (~/.insta-oss/state.json, override INSTA_OSS_STATE).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project, Branch, Approval, AuditEvent, GatedAction, Decision, UserSecret } from './types'

export interface State {
  projects: Record<string, Project>
  branches: Record<string, Branch> // keyed by branch id
  policies: Record<string, Partial<Record<GatedAction, Decision>>> // per project
  approvals: Approval[]
  events: AuditEvent[]
  userSecrets: Record<string, UserSecret[]> // per project id
}

const EMPTY: State = { projects: {}, branches: {}, policies: {}, approvals: [], events: [], userSecrets: {} }
const statePath = (): string => process.env.INSTA_OSS_STATE ?? join(homedir(), '.insta-oss', 'state.json')

export function loadState(): State {
  const p = statePath()
  if (!existsSync(p)) return structuredClone(EMPTY)
  return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(p, 'utf8')) as State) }
}

export function saveState(s: State): void {
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(s, null, 2))
}

/** Read-modify-write helper so callers never hold stale copies. */
export function mutate<T>(fn: (s: State) => T): T {
  const s = loadState()
  const out = fn(s)
  saveState(s)
  return out
}
