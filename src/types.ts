// Model mirrors the Instacloud platform (project → branch; branch = disposable isolated env).
// Adapters follow the platform's ProviderAdapter shape, restated here so this repo stays
// independent of the closed-source platform. Local branch models: db = copy (pg_dump→restore),
// compute = redeploy.

export type Decision = 'allow' | 'deny' | 'approve'
export const GATED_ACTIONS = ['secrets.read', 'secrets.write', 'deploy', 'project.delete', 'branch.delete', 'service.add', 'service.remove', 'service.setAccess', 'service.rename'] as const
export type GatedAction = (typeof GATED_ACTIONS)[number]
export const isGatedAction = (a: string): a is GatedAction => (GATED_ACTIONS as readonly string[]).includes(a)

// Managed private databases (cloud parity: platform serviceTypes.ts MANAGED_FLY_DATABASE_TYPES).
// Locally each is one container per branch on the branch network — reachable only there, like the
// cloud's private-tcp `.internal` hosts.
export type ManagedDbType = 'redis' | 'mysql' | 'mongodb'

export interface Project {
  id: string; name: string; status: string; createdAt: number; computeGroups?: string[]
  // Compute /data volumes by group (attach at create or any time later; grow-only; deletable —
  // the disk and its data go together, there is no detach). `id` keys the docker volume so the
  // data survives a service rename. The recorded size is ADVISORY on the local substrate (docker
  // named volumes have no quota) — kept for contract-shape parity with the cloud.
  computeVolumes?: Record<string, { id: string; sizeGib: number }>
  // Managed databases registered on the project (like computeGroups), materialized as one
  // container per branch. Order = creation order; the oldest per type gets the canonical
  // unsuffixed secret aliases (cloud spec §2.1).
  managedServices?: Array<{ id: string; type: ManagedDbType; name: string; createdAt: number }>
}

// User-defined secret (via `insta secrets set`): project-wide when branch is null. `service`
// binds it to a branch service ("<type>/<name>", requires a branch) — platform spec §5.
export interface UserSecret { name: string; value: string; branch: string | null; service?: string | null }

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
  // storage access mode for this branch's bucket (anonymous public-read vs private)
  storagePublic?: boolean
  // DB volume (block disk) size in whole Gi — settings parity with the cloud (grow-only).
  // Advisory locally: the postgres container's disk is unbounded; default 10.
  dbVolumeGib?: number
  // deployed app per compute group (group -> spec); desiredState = developer lifecycle intent
  apps: Record<string, { image: string; port: number; hostPort?: number; url: string; updatedAt?: number; desiredState?: 'running' | 'stopped' | 'suspended' }>
  // per-branch managed-database credentials, keyed by service id. Only the password persists —
  // hosts derive from the current container name at read time, so a rename never strands a URL.
  // A branch clone mints a FRESH password over an EMPTY instance (cloud parity: no data clones).
  managed?: Record<string, { password: string }>
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
  // /data volumes (optional — platform parity for create-time volumeGib + PUT …/volume). An
  // adapter that can mount persistent volumes declares supportsVolumes and honors opts.volume;
  // adapters that can't (e.g. Railway — its volumes don't map onto this deploy path) leave it
  // unset and the engine rejects volume-carrying services with a clear error.
  supportsVolumes?: boolean
  deploy(
    ref: string,
    // port = the port the app LISTENS on (never changes). hostPort/network are LOCAL-substrate
    // hints (docker host mapping + branch network); platform adapters (Railway, …) ignore them
    // and own their routing/URL story. volume = a named volume to mount at /data.
    opts: { image: string; port: number; hostPort?: number; envVars: Record<string, string>; network?: string; group: string; volume?: { name: string } },
  ): Promise<{ url: string }>
  destroy(ref: string): Promise<void>
  // Lifecycle (optional — platform parity for `insta compute start|stop|suspend|status`).
  // Adapters that can't control a deployed app's runtime simply omit these.
  start?(ref: string, group: string): Promise<void>
  stop?(ref: string, group: string): Promise<void>
  suspend?(ref: string, group: string): Promise<void>
  state?(ref: string, group: string): Promise<string> // running|suspended|stopped|none|unknown
  // Rename a deployed group's runtime artifact (optional — `insta services rename compute`).
  rename?(ref: string, from: string, to: string): Promise<void>
}

export interface ManagedDbAdapter {
  // One managed-database container per branch per service; `ref` identifies the branch. There is
  // deliberately no clone method — a branch gets a fresh empty instance (cloud parity).
  provision(ref: string, network: string, type: ManagedDbType, name: string, password: string): Promise<void>
  destroy(ref: string, type: ManagedDbType, name: string): Promise<void>
  rename(ref: string, type: ManagedDbType, from: string, to: string): Promise<void>
}

export interface StorageAdapter {
  provision(ref: string, network: string): Promise<{ bucket: string; env: Record<string, string> }>
  cloneInto(srcRef: string, dstRef: string, network: string): Promise<void>
  destroy(ref: string, network: string): Promise<void>
  // Bucket access mode (optional — `insta services set-access storage <name> public|private`).
  setAccess?(ref: string, network: string, isPublic: boolean): Promise<void>
}
