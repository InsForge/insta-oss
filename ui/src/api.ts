// Typed same-origin client over the instad API. Every mutation is HITL-aware: a 202 surfaces
// as {kind:'approval'} so any page can pop the approval modal and retry after the grant.
// This file is the seam that later extracts into the shared insta-ui package.

export type Project = { id: string; name: string; status: string }
export type BranchInfo = { id: string; name: string; is_default: boolean; status: string }
export type Service = {
  id: string; type: 'postgres' | 'storage' | 'compute'; name: string; status: string
  machine_count?: number; domain?: string; public?: boolean; desired_state?: string
  runtime?: 'online' | 'stopped' | 'none'; endpoint?: string; updated_at?: string
}
export type DbMetrics = {
  connections: { active: number; idle: number; total: number; max: number }
  dbSizeBytes: number; deadlocks: number
  tuples: { inserted: number; updated: number; deleted: number }; cacheHitRatio: number
}
export type DbActivityRow = {
  pid: number; state?: string; waitEvent?: string; durationMs?: number
  query?: string; application?: string; client?: string; queryStart?: string
}
export type DbQueryStatRow = { queryId: string; query: string; calls: number; meanMs: number; totalMs: number; rows: number }
export type DbQueryStats = { stats: DbQueryStatRow[]; extensionReady: boolean }
export type Operation = { id: string; action: string; status: string; createdAt?: string }
export type SecretTree = {
  projectWide: string[]
  branches: Array<{
    name: string; isDefault: boolean
    services: Array<{ type: string; name: string; secrets: string[] }>
    unbound: string[]
  }>
}
export type LogLine = { ts: string; level?: string; message: string; instance?: string }
export type LogsResult = { source: string; lines: LogLine[]; note?: string }
export type MetricSeries = { name: string; unit?: string; labels?: Record<string, string>; points: Array<[number, number]> }
export type MetricsResult = { source: string; series: MetricSeries[]; note?: string }
export type Approval = { id: string; action: string; status: string; requested_at: string; decided_at: string | null }
export type AuditEvent = { id: string; branch: string | null; source: string; kind: string; payload: unknown; created_at: string }
export type Decision = 'allow' | 'deny' | 'approve'
export type Policy = Record<string, Decision>

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'approval'; action: string; approvalId: string }
  | { kind: 'error'; status: number; error: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return { kind: 'error', status: 0, error: 'daemon unreachable' }
  }
  const data = await res.json().catch(() => ({}))
  if (res.status === 202 && data?.status === 'approval_required') {
    return { kind: 'approval', action: data.action, approvalId: data.approvalId }
  }
  if (!res.ok) return { kind: 'error', status: res.status, error: data?.error ?? `HTTP ${res.status}` }
  return { kind: 'ok', data: data as T }
}

/** GET that throws on failure — for read paths driven by usePoll. */
async function get<T>(path: string): Promise<T> {
  const r = await call<T>('GET', path)
  if (r.kind === 'ok') return r.data
  if (r.kind === 'approval') throw new Error(`approval required: ${r.action}`)
  throw Object.assign(new Error(r.error), { status: r.status })
}

export const api = {
  health: () => get<{ ok: boolean }>('/healthz'),
  projects: async () => (await get<{ projects: Project[] }>('/orgs/local/projects')).projects,
  branches: async (p: string) => (await get<{ branches: BranchInfo[] }>(`/projects/${p}/branches`)).branches,
  services: async (p: string, branch: string) =>
    (await get<{ services: Service[] }>(`/projects/${p}/services?branch=${encodeURIComponent(branch)}`)).services,
  approvals: async (p: string) => (await get<{ approvals: Approval[] }>(`/projects/${p}/approvals`)).approvals,
  policy: async (p: string) => (await get<{ policy: Policy }>(`/projects/${p}/policy`)).policy,
  events: async (p: string, limit = 30) => (await get<{ events: AuditEvent[] }>(`/projects/${p}/events?limit=${limit}`)).events,
  logs: (p: string, component: 'compute' | 'db', branch: string, limit = 200) =>
    get<LogsResult>(`/projects/${p}/logs?component=${component}&branch=${encodeURIComponent(branch)}&limit=${limit}`),
  metrics: (p: string, component: 'compute' | 'db', branch: string) =>
    get<MetricsResult>(`/projects/${p}/metrics?component=${component}&branch=${encodeURIComponent(branch)}`),

  // Names-only inventory — the dashboard never shows secret VALUES (plan v1 non-goal; values
  // stay behind `insta secrets`, secrets.read-gated). This route emits no audit event.
  secretTree: (p: string) => get<SecretTree>(`/projects/${p}/secrets/tree`),
  dbMetrics: (p: string, branch: string) =>
    get<DbMetrics>(`/projects/${p}/database/metrics?branch=${encodeURIComponent(branch)}`),
  dbActivity: async (p: string, branch: string) =>
    (await get<{ activity: DbActivityRow[] }>(`/projects/${p}/database/activity?branch=${encodeURIComponent(branch)}`)).activity,
  dbQueryStats: (p: string, branch: string) =>
    get<DbQueryStats>(`/projects/${p}/database/query-stats?branch=${encodeURIComponent(branch)}&limit=20`),
  operations: async (p: string, limit = 50) =>
    (await get<{ operations: Operation[] }>(`/projects/${p}/operations?limit=${limit}`)).operations,

  setSecret: (p: string, name: string, value: string, branch?: string) =>
    call<{ ok: boolean }>('PUT', `/projects/${p}/secrets/${encodeURIComponent(name)}`, branch ? { value, branch } : { value }),
  unsetSecret: (p: string, name: string, branch?: string) =>
    call<{ ok: boolean }>('DELETE', `/projects/${p}/secrets/${encodeURIComponent(name)}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`),
  renameService: (p: string, sid: string, name: string) =>
    call<{ service: Service }>('POST', `/projects/${p}/services/${sid}/rename`, { name }),
  lifecycle: (p: string, sid: string, verb: 'start' | 'stop' | 'suspend', branch: string) =>
    call<{ service?: Service; state: string }>('POST', `/projects/${p}/services/${sid}/${verb}?branch=${encodeURIComponent(branch)}`),
  setAccess: (p: string, sid: string, isPublic: boolean, branch: string) =>
    call<{ service?: Service }>('PUT', `/projects/${p}/services/${sid}/access`, { public: isPublic, branch }),

  createBranch: (p: string, name: string, from: string) =>
    call<{ branch: { id: string; name: string } }>('POST', `/projects/${p}/branches`, { name, from }),
  deleteBranch: (p: string, branchId: string) =>
    call<{ ok: boolean }>('DELETE', `/projects/${p}/branches/${branchId}`),
  addComputeService: (p: string, name: string) =>
    call<{ service: unknown }>('POST', `/projects/${p}/services`, { type: 'compute', name }),
  removeService: (p: string, sid: string) => call<{ ok: boolean }>('DELETE', `/projects/${p}/services/${sid}`),
  setPolicy: (p: string, action: string, decision: Decision) =>
    call<{ policy: Policy }>('PUT', `/projects/${p}/policy/${action}`, { decision }),
  decide: (p: string, approvalId: string, verdict: 'approve' | 'deny', always = false) =>
    call<{ approval: Approval }>('POST', `/projects/${p}/approvals/${approvalId}/${verdict}`, always ? { always } : undefined),
}

export function relTime(iso?: string): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min${Math.round(s / 60) === 1 ? '' : 's'} ago`
  if (s < 86400) return `${Math.round(s / 3600)} hr${Math.round(s / 3600) === 1 ? '' : 's'} ago`
  return `${Math.round(s / 86400)} d ago`
}
