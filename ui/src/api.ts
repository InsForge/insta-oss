// Typed same-origin client over the instad API. Every mutation is HITL-aware: a 202 surfaces
// as {kind:'approval'} so any page can pop the approval modal and retry after the grant.
// This file is the seam that later extracts into the shared insta-ui package.

export type Project = { id: string; name: string; status: string }
export type BranchInfo = { id: string; name: string; is_default: boolean; status: string }
export type Service = {
  id: string; type: 'postgres' | 'storage' | 'compute'; name: string; status: string
  machine_count?: number; domain?: string
  runtime?: 'online' | 'stopped' | 'none'; endpoint?: string; updated_at?: string
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
