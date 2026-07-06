// Model mirrors the Instacloud platform (project → branch; branch = disposable isolated env).
// Adapters follow the platform's ProviderAdapter shape, restated here so this repo stays
// independent of the closed-source platform. Local branch models: db = copy (pg_dump→restore),
// compute = redeploy.

export type Decision = 'allow' | 'deny' | 'approve'
export const GATED_ACTIONS = ['secrets.read', 'secrets.write', 'deploy', 'project.delete', 'branch.delete', 'service.add', 'service.remove'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a)

export interface Project { id: string; name: string; status: string; createdAt: number; computeGroups?: string[] }

// User-defined secret (via `insta secrets set`): project-wide when branch is null.
export interface UserSecret { name: string; value: string; branch: string | null }

export interface Branch {
  id: string
  projectId: string
  name: string
  isDefault: boolean
  status: string
  network: string
  dbUrl: string
  bucket: string
  s3: Record<string, string> // S3 credential bundle for this branch (endpoint, keys, bucket)
  cloneOf: string | null
  createdAt: number
  // deployed app per compute group (group -> spec)
  apps: Record<string, { image: string; port: number; hostPort?: number; url: string }>
}

export interface Approval {
  id: string
  projectId: string
  action: GatedAction
  status: 'pending' | 'granted' | 'denied' | 'consumed'
  requestedAt: string
  decidedAt: string | null
}

export interface AuditEvent {
  id: string
  projectId: string
  branch: string | null
  source: 'agent' | 'resource' | 'govern'
  kind: string
  payload: unknown
  dedupKey: string | null
  createdAt: string
}

export interface DatabaseAdapter {
  provision(ref: string, network: string): Promise<{ url: string }>
  query(ref: string, sql: string): Promise<string>
  cloneInto(srcRef: string, dstRef: string): Promise<void>
  destroy(ref: string): Promise<void>
}

export interface ComputeAdapter {
  deploy(
    ref: string,
    // port = the port the app LISTENS on (never changes); hostPort = the host-side mapping.
    opts: { image: string; port: number; hostPort: number; envVars: Record<string, string>; network: string; group: string },
  ): Promise<{ url: string }>
  destroy(ref: string): Promise<void>
}

export interface StorageAdapter {
  provision(ref: string, network: string): Promise<{ bucket: string; env: Record<string, string> }>
  cloneInto(srcRef: string, dstRef: string, network: string): Promise<void>
  destroy(ref: string, network: string): Promise<void>
}
