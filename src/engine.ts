// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomBytes, randomUUID } from 'node:crypto'
import { docker } from './docker'
import { MANAGED_DB, CANONICAL_MANAGED_KEYS, suffixBundle, managedServiceId, managedContainerName, isManagedDbType } from './manageddb'
import * as observe from './observe'
import { loadState, mutate } from './state'
import type { Branch, Project, DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, ManagedDbType, ObservedComponent, ObjectListing, AuditEvent, UserSecret } from './types'

const DEFAULT_BRANCH = 'main'
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

// Volume-cap parity (platform #166–169): the cloud caps volumes per billing tier; oss has no
// tiers, so one fixed generous cap serves every project. Grow-only validation is kept so the
// same CLI sequence behaves identically on both targets. Sizes are ADVISORY locally — neither
// docker named volumes nor the postgres container enforce a byte quota.
const VOLUME_CAP_GIB = 100
const DB_VOLUME_DEFAULT_GIB = 10
const DB_CAP = { cpuMilli: 8000, memoryMib: 8192, volumeGib: VOLUME_CAP_GIB }
const VOLUME_MOUNT_PATH = '/data'

export class Engine {
  constructor(private db: DatabaseAdapter, private compute: ComputeAdapter, private storage: StorageAdapter, private managedDb: ManagedDbAdapter) {}

  // The project's container-ref slug — frozen at creation (older state derives from the name).
  private projectSlug(project: Project): string { return project.refSlug ?? slug(project.name) }

  // Branch ref keys containers/networks: <project-slug>-<branch-name>, FROZEN at provision.
  // Passing a Branch reads the stored ref (older state derives from the name — same value until
  // the branch is renamed); a string is the provision-time path, before the Branch exists.
  private ref(project: Project, branch: Branch | string): string {
    if (typeof branch !== 'string') return branch.ref ?? this.ref(project, branch.name)
    return `${this.projectSlug(project)}-${slug(branch)}`
  }
  private net(project: Project, branch: string): string { return `io-${this.ref(project, branch)}` }

  emit(projectId: string, branch: string | null, source: AuditEvent['source'], kind: string, payload: unknown = {}, dedupKey: string | null = null): void {
    mutate((s) => {
      if (dedupKey && s.events.some((e) => e.projectId === projectId && e.dedupKey === dedupKey)) return
      s.events.push({ id: randomUUID(), projectId, branch, source, kind, payload, dedupKey, createdAt: new Date().toISOString() })
    })
  }

  getProject(id: string): Project | undefined { return loadState().projects[id] }
  listEvents(projectId: string): AuditEvent[] { return loadState().events.filter((e) => e.projectId === projectId) }
  listProjects(): Project[] { return Object.values(loadState().projects) }
  listBranches(projectId: string): Branch[] { return Object.values(loadState().branches).filter((b) => b.projectId === projectId) }
  getBranchByName(projectId: string, name: string): Branch | undefined {
    return this.listBranches(projectId).find((b) => b.name === name)
  }

  private async provisionBranch(project: Project, name: string, isDefault: boolean, cloneOf: string | null): Promise<Branch> {
    const network = this.net(project, name)
    try { await docker(['network', 'create', network]) } catch { /* exists */ }
    const ref = this.ref(project, name)
    const { url } = await this.db.provision(ref, network)
    let st: { bucket: string; env: Record<string, string> }
    try { st = await this.storage.provision(ref, network) }
    catch (e) {
      // compensate: don't orphan the db container if storage fails
      await this.db.destroy(ref).catch(() => {})
      await docker(['network', 'rm', network]).catch(() => {})
      throw e
    }
    // Managed databases: every branch gets a FRESH empty instance with a fresh password — no data
    // clones from the parent (cloud parity: platform materialize() for managed Fly databases).
    const managed: Record<string, { password: string }> = {}
    const provisioned: Array<{ type: ManagedDbType; name: string }> = []
    try {
      for (const m of project.managedServices ?? []) {
        const password = randomBytes(32).toString('base64url')
        await this.managedDb.provision(ref, network, m.type, m.name, password)
        provisioned.push({ type: m.type, name: m.name })
        managed[m.id] = { password }
      }
    } catch (e) {
      // compensate: tear down the whole half-provisioned branch stack
      for (const p of provisioned) await this.managedDb.destroy(ref, p.type, p.name).catch(() => {})
      await this.storage.destroy(ref, network).catch(() => {})
      await this.db.destroy(ref).catch(() => {})
      await docker(['network', 'rm', network]).catch(() => {})
      throw e
    }
    const b: Branch = {
      id: randomUUID(), projectId: project.id, name, isDefault, status: 'ready', ref,
      network, dbUrl: url, bucket: st.bucket, s3: st.env, cloneOf, createdAt: Date.now(), apps: {},
      ...(Object.keys(managed).length ? { managed } : {}),
    }
    mutate((s) => { s.branches[b.id] = b })
    return b
  }

  async createProject(name: string): Promise<{ project: Project; defaultBranch: Branch }> {
    if (this.listProjects().some((p) => p.name === name)) throw new Error(`project "${name}" already exists`)
    // Slugs are frozen per project and outlive renames, so a NEW project must not reuse one —
    // its containers would collide with resources a renamed project still owns.
    const refSlug = slug(name)
    if (this.listProjects().some((p) => this.projectSlug(p) === refSlug)) {
      throw new Error(`project ref "${refSlug}" already exists (a renamed project still owns its original resource names)`)
    }
    const project: Project = { id: randomUUID(), name, status: 'ready', createdAt: Date.now(), refSlug }
    mutate((s) => { s.projects[project.id] = project })
    try {
      const defaultBranch = await this.provisionBranch(project, DEFAULT_BRANCH, true, null)
      this.emit(project.id, DEFAULT_BRANCH, 'resource', 'project.created', { name })
      return { project, defaultBranch }
    } catch (e) {
      // compensate: never leave a half-provisioned project behind
      mutate((s) => { delete s.projects[project.id] })
      throw e
    }
  }

  async createBranch(projectId: string, name: string, from?: string): Promise<Branch> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const source = this.getBranchByName(projectId, from ?? DEFAULT_BRANCH)
    if (!source) throw new Error(`source branch "${from ?? DEFAULT_BRANCH}" not found`)
    if (this.getBranchByName(projectId, name)) throw new Error(`branch "${name}" already exists`)

    const b = await this.provisionBranch(project, name, false, source.name)
    await this.db.cloneInto(this.ref(project, source), this.ref(project, name))
    await this.storage.cloneInto(this.ref(project, source), this.ref(project, name), b.network)
    // compute = redeploy: same image, SAME listen port, allocated host mapping.
    for (const [group, app] of Object.entries(source.apps)) {
      await this.deployAllocatingPort(projectId, name, group, app)
    }
    // platform parity: the parent branch's user-defined (branch-scoped) secrets clone onto the new branch
    mutate((st) => {
      const list = st.userSecrets[projectId] ?? []
      const inherited = list.filter((u) => u.branch === source.name).map((u) => ({ ...u, branch: name }))
      st.userSecrets[projectId] = [...list, ...inherited]
      // the DB volume-size setting travels with the clone (it describes the copied database)
      if (source.dbVolumeGib !== undefined) st.branches[b.id].dbVolumeGib = source.dbVolumeGib
    })
    this.emit(projectId, name, 'resource', 'branch.created', { from: source.name })
    return b
  }

  /** Rename a project — DISPLAY NAME ONLY, like the cloud: every resource keeps its original
   *  name (the ref slug froze at creation, so even branches created later stay on it). */
  renameProject(projectId: string, name: string): { id: string; name: string; status: string } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    if (!name.trim() || name.length > 100) throw new Error('name must be 1..100 characters')
    if (name !== project.name && this.listProjects().some((p) => p.name === name)) throw new Error(`project "${name}" already exists`)
    mutate((st) => {
      // freeze the slug before the name moves (older records derive it from the name)
      st.projects[projectId].refSlug ??= this.projectSlug(project)
      st.projects[projectId].name = name
    })
    this.emit(projectId, null, 'resource', 'project.rename', { from: project.name, to: name })
    return { id: projectId, name, status: project.status }
  }

  /** Rename a branch — METADATA ONLY, like the cloud: provider resources (containers, network,
   *  bucket, minted creds) keep their frozen ref. Not the default branch; lower-kebab; unique. */
  renameBranch(projectId: string, branchId: string, newName: string): { id: string; name: string; is_default: boolean; status: string } {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot rename the default branch')
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newName)) throw new Error('branch name must be lower-kebab (a-z, 0-9, -)')
    if (newName !== b.name && this.getBranchByName(projectId, newName)) throw new Error(`branch "${newName}" already exists`)
    const oldName = b.name
    mutate((st) => {
      // freeze the ref before the name moves (older records derive it from the name)
      st.branches[branchId].ref ??= this.ref(project, oldName)
      st.branches[branchId].name = newName
      // branch-scoped user secrets are keyed by branch NAME — they follow the rename
      for (const u of st.userSecrets[projectId] ?? []) if (u.branch === oldName) u.branch = newName
    })
    this.emit(projectId, newName, 'resource', 'branch.rename', { from: oldName, to: newName })
    const renamed = loadState().branches[branchId]
    return { id: renamed.id, name: renamed.name, is_default: renamed.isDefault, status: renamed.status }
  }

  async deploy(projectId: string, branchName: string, opts: { image: string; port?: number; hostPort?: number; group?: string }): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    const group = opts.group ?? 'default'
    const port = opts.port ?? 8080
    // a redeploy keeps the branch app's existing host address; only brand-new apps default to port.
    // Older state records lack hostPort — recover it from the recorded URL.
    const prior = b.apps[group]
    const priorHost = prior?.hostPort ?? (prior?.url ? Number(new URL(prior.url).port) || undefined : undefined)
    const hostPort = opts.hostPort ?? priorHost ?? port
    // The group's /data volume, if one was attached at service creation. Named per-branch (each
    // branch is isolated; a clone starts with an EMPTY volume — compute state lives in db/storage)
    // and keyed by the volume's stable id so a service rename never detaches the data.
    const vol = project.computeVolumes?.[group]
    if (vol && !this.compute.supportsVolumes) {
      throw new Error(`service "${group}" has a /data volume, which this compute adapter does not support — use the docker adapter`)
    }
    const { url } = await this.compute.deploy(this.ref(project, b), {
      image: opts.image, port, hostPort, network: b.network, group,
      ...(vol ? { volume: { name: `io-${this.ref(project, b)}-data-${vol.id}` } } : {}),
      // minted credentials (db + storage + managed databases) reach every compute deploy; user
      // secrets are scoped (project-wide + branch-unbound + bound to THIS group)
      envVars: { ...b.s3, DATABASE_URL: b.dbUrl, ...this.managedSecretsFor(projectId, b), ...this.deploySecretsFor(projectId, b.name, group) },
    })
    // Spread, not replace: desiredState is the user's standing intent and this write is not the
    // place to clear it. A `stop` landing while a deploy is in flight would otherwise be undone by
    // the deploy's own state write — and `restart` makes that reachable from an operation that
    // checked the intent moments earlier. Matches the platform, whose desired_state survives a deploy.
    mutate((s) => { s.branches[b.id].apps[group] = { ...s.branches[b.id].apps[group], image: opts.image, port, hostPort, url, updatedAt: Date.now() } })
    this.emit(projectId, b.name, 'resource', 'deploy', { image: opts.image, group, url })
    return { url, branch: b.name, group }
  }

  /** Deploy an app spec onto a branch with an allocated host mapping. The naive parent+1000
   *  collides as soon as a second branch exists (or the OS holds the port — e.g. macOS AirPlay
   *  on 5000), so allocate from state and retry on bind failures. */
  private async deployAllocatingPort(projectId: string, branchName: string, group: string, app: { image: string; port: number }): Promise<void> {
    let lastErr: unknown
    for (const candidate of this.freeHostPorts(app.port, 5)) {
      try {
        await this.deploy(projectId, branchName, { image: app.image, port: app.port, hostPort: candidate, group })
        return
      } catch (e) {
        lastErr = e
        if (!/port is already allocated|address already in use/i.test(e instanceof Error ? e.message : '')) throw e
      }
    }
    throw lastErr
  }

  /** Host-port candidates for a branch redeploy: base+1000·k, skipping ports any app already uses. */
  private freeHostPorts(basePort: number, count: number): number[] {
    const used = new Set<number>()
    for (const b of Object.values(loadState().branches)) {
      for (const app of Object.values(b.apps)) used.add(app.hostPort ?? app.port)
    }
    const out: number[] = []
    for (let k = 1; out.length < count && k < 50; k++) {
      const cand = basePort + 1000 * k
      if (!used.has(cand)) out.push(cand)
    }
    return out
  }

  secrets(projectId: string, branchName: string): Record<string, string> {
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    return { DATABASE_URL: b.dbUrl, ...b.s3, ...this.managedSecretsFor(projectId, b), ...this.userSecretsFor(projectId, branchName) }
  }

  /** Minted managed-database credentials for a branch, on the cloud's naming contract: every
   *  service's bundle stored SUFFIXED (`REDIS_URL_<NAME>`), and the oldest service of each type
   *  additionally surfaces the canonical unsuffixed aliases — computed here at read time, so
   *  removing the oldest shifts the aliases on the next read (platform spec §2.1). */
  private managedSecretsFor(projectId: string, branch: Branch): Record<string, string> {
    const project = this.getProject(projectId)
    const out: Record<string, string> = {}
    const aliasedTypes = new Set<ManagedDbType>()
    for (const m of project?.managedServices ?? []) {
      const cred = branch.managed?.[m.id]
      if (!cred) continue
      const host = managedContainerName(this.ref(project!, branch), m.type, m.name)
      const bundle = MANAGED_DB[m.type].bundle(host, cred.password)
      Object.assign(out, suffixBundle(bundle, m.name))
      if (!aliasedTypes.has(m.type)) { aliasedTypes.add(m.type); Object.assign(out, bundle) }
    }
    return out
  }

  // ---- user-defined secrets (insta secrets set/unset) ----

  /** Effective user secrets for a branch: project-wide first, branch-scoped override. */
  userSecretsFor(projectId: string, branchName: string): Record<string, string> {
    const list = loadState().userSecrets[projectId] ?? []
    const out: Record<string, string> = {}
    for (const u of list) if (u.branch === null) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName) out[u.name] = u.value
    return out
  }

  /** Env for one compute group's deploy: project-wide + branch-unbound + secrets bound to
   *  THIS group. Secrets bound to a different service never leak into another group's env. */
  private deploySecretsFor(projectId: string, branchName: string, group: string): Record<string, string> {
    const list = loadState().userSecrets[projectId] ?? []
    const out: Record<string, string> = {}
    for (const u of list) if (u.branch === null) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName && !u.service) out[u.name] = u.value
    for (const u of list) if (u.branch === branchName && u.service === `compute/${group}`) out[u.name] = u.value
    return out
  }

  /** Reserved = platform-minted credential names — user secrets must not clobber them. Managed
   *  types reserve their canonical keys and every suffixed form (`REDIS_URL_<NAME>` etc.),
   *  matching the stance already taken for DATABASE_URL_/BUCKET_NAME_. */
  isReservedSecret(name: string): boolean {
    if (name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
      name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')) return true
    for (const k of CANONICAL_MANAGED_KEYS) if (name === k || name.startsWith(`${k}_`)) return true
    return false
  }

  setUserSecret(projectId: string, name: string, value: string, branch: string | null, service: string | null = null): void {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (this.isReservedSecret(name)) throw new Error(`"${name}" is a reserved platform credential name`)
    if (branch && !this.getBranchByName(projectId, branch)) throw new Error(`branch "${branch}" not found`)
    if (service) {
      if (!branch) throw new Error('binding a secret to a service requires a branch')
      const valid = ['postgres/db', 'storage/store',
        ...this.computeGroupNames(projectId).map((g) => `compute/${g}`),
        ...this.managedList(projectId).map((m) => `${m.type}/${m.name}`)]
      if (!valid.includes(service)) throw new Error(`service not found: ${service}`)
    }
    mutate((st) => {
      const list = (st.userSecrets[projectId] ??= [])
      const existing = list.find((u) => u.name === name && u.branch === branch)
      if (existing) { existing.value = value; existing.service = service }
      else list.push({ name, value, branch, service } satisfies UserSecret)
    })
    this.emit(projectId, branch, 'govern', 'secrets.write', { name, scope: branch ?? 'project', service })
  }

  unsetUserSecret(projectId: string, name: string, branch: string | null): void {
    mutate((st) => {
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => !(u.name === name && u.branch === branch))
    })
    this.emit(projectId, branch, 'govern', 'secrets.unset', { name, scope: branch ?? 'project' })
  }

  // ---- services view (services model parity) ----

  /** host:port of a branch's S3 server, from its minted endpoint credential. */
  private s3Host(b: Branch): string | undefined {
    try { return new URL(b.s3.AWS_ENDPOINT_URL_S3).host } catch { return undefined }
  }

  /** Every compute group name: registered on the project plus any group already deployed. */
  private computeGroupNames(projectId: string): string[] {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set<string>(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    return [...groups].sort()
  }

  /** The project's registered managed databases (empty when none). */
  private managedList(projectId: string): Array<{ id: string; type: ManagedDbType; name: string; createdAt: number }> {
    return this.getProject(projectId)?.managedServices ?? []
  }

  /** Resolve a stable oss service id (pg-db | st-store | cp-<group> | rd/my/mo-<name>) to its type + name. */
  private serviceOf(projectId: string, serviceId: string): { type: 'postgres' | 'storage' | 'compute' | ManagedDbType; name: string } {
    if (serviceId === 'pg-db') return { type: 'postgres', name: 'db' }
    if (serviceId === 'st-store') return { type: 'storage', name: 'store' }
    if (serviceId.startsWith('cp-') && this.computeGroupNames(projectId).includes(serviceId.slice(3))) {
      return { type: 'compute', name: serviceId.slice(3) }
    }
    const managed = this.managedList(projectId).find((m) => m.id === serviceId)
    if (managed) return { type: managed.type, name: managed.name }
    throw new Error('service not found')
  }

  /** The project's services as the CLI expects them: the fixed postgres + storage pair and
   *  one compute service per group (registered or already deployed on the default branch).
   *  Additive dashboard fields (never touching `status`, which the CLI prints): `runtime`
   *  from live docker ps, `endpoint` (everything is local — container:port or host url),
   *  `updated_at`. Branch-aware via `branchName` (defaults to the default branch). */
  async services(projectId: string, branchName?: string): Promise<Array<{
    id: string; type: string; name: string; status: string; machine_count?: number; domain?: string
    runtime?: string; endpoint?: string; updated_at?: string; public?: boolean; desired_state?: string
    volume_gib?: number | null; port?: number
  }>> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    const branch = branchName ? branches.find((b) => b.name === branchName) : branches.find((b) => b.isDefault)
    if (branchName && !branch) throw new Error(`branch "${branchName}" not found`)
    const groups = new Set<string>(this.computeGroupNames(projectId))
    let running: Set<string> | null = null
    try {
      const out = await docker(['ps', '--format', '{{.Names}}'])
      running = new Set(out.toString().trim().split('\n').filter(Boolean))
    } catch { /* docker unavailable — omit runtime rather than guess */ }
    const ref = branch ? this.ref(project, branch) : undefined
    const iso = (ms?: number): string | undefined => (ms ? new Date(ms).toISOString() : undefined)
    const runtimeOf = (container: string): string | undefined =>
      running ? (running.has(container) ? 'online' : 'stopped') : undefined
    return [
      { id: 'pg-db', type: 'postgres', name: 'db', status: 'ready',
        endpoint: ref ? `io-${ref}-pg:5432` : undefined,
        runtime: ref ? runtimeOf(`io-${ref}-pg`) : undefined,
        updated_at: iso(branch?.createdAt) },
      // Storage endpoint/container derive from the branch's OWN minted creds, so branches
      // provisioned by an older storage adapter still report their real server.
      { id: 'st-store', type: 'storage', name: 'store', status: 'ready',
        public: branch?.storagePublic ?? false,
        endpoint: branch ? `${this.s3Host(branch) ?? 'storage'}/${branch.bucket}` : undefined,
        runtime: branch ? runtimeOf(this.s3Host(branch)?.split(':')[0] ?? '') : undefined,
        updated_at: iso(branch?.createdAt) },
      // Managed databases (redis/mysql/mongodb): one private container per branch. `port` +
      // `volume_gib` are what the CLI renders (`tcp/6379  vol 1Gi`); the volume size is the
      // cloud's fixed 1Gi, advisory locally like every other recorded size.
      ...this.managedList(projectId).map((m) => {
        const container = ref ? managedContainerName(ref, m.type, m.name) : undefined
        return {
          id: m.id, type: m.type, name: m.name, status: 'ready',
          port: MANAGED_DB[m.type].port, volume_gib: MANAGED_DB[m.type].volumeGib,
          endpoint: container ? `${container}:${MANAGED_DB[m.type].port}` : undefined,
          runtime: container ? runtimeOf(container) : undefined,
          updated_at: iso(m.createdAt),
        }
      }),
      ...[...groups].sort().map((g) => {
        const app = branch?.apps[g]
        return {
          id: `cp-${g}`, type: 'compute', name: g, status: 'ready', machine_count: 1,
          volume_gib: project.computeVolumes?.[g]?.sizeGib ?? null, // platform Service.volume_gib (compute only)
          desired_state: app?.desiredState ?? 'running',
          domain: app?.url,
          endpoint: app ? app.url.replace(/^https?:\/\//, '') : undefined,
          runtime: app && ref ? runtimeOf(`io-${ref}-app-${g}`) : app ? undefined : 'none',
          updated_at: iso(app?.updatedAt),
        }
      }),
    ]
  }

  /** Names-only secret inventory as project→branch→service→secrets (SecretTree contract shape).
   *  Minted credential names sit under their service (DATABASE_URL → postgres, AWS_* / BUCKET_NAME
   *  → storage), matching the cloud, where minted secrets are service-bound rows. */
  secretTree(projectId: string): {
    projectWide: string[]
    branches: Array<{ name: string; isDefault: boolean; services: Array<{ type: string; name: string; secrets: string[] }>; unbound: string[] }>
  } {
    if (!this.getProject(projectId)) throw new Error('project not found')
    const list = loadState().userSecrets[projectId] ?? []
    const groups = this.computeGroupNames(projectId)
    const bound = (branch: string, service: string): string[] =>
      list.filter((u) => u.branch === branch && u.service === service).map((u) => u.name)
    return {
      projectWide: list.filter((u) => u.branch === null).map((u) => u.name).sort(),
      branches: this.listBranches(projectId).map((b) => ({
        name: b.name,
        isDefault: b.isDefault,
        services: [
          { type: 'postgres', name: 'db', secrets: ['DATABASE_URL', ...bound(b.name, 'postgres/db')].sort() },
          { type: 'storage', name: 'store', secrets: [...Object.keys(b.s3), ...bound(b.name, 'storage/store')].sort() },
          ...this.managedList(projectId).map((m) => ({
            type: m.type, name: m.name,
            secrets: [...this.mintedManagedNames(m), ...bound(b.name, `${m.type}/${m.name}`)].sort(),
          })),
          ...groups.map((g) => ({ type: 'compute', name: g, secrets: bound(b.name, `compute/${g}`).sort() })),
        ],
        unbound: list.filter((u) => u.branch === b.name && !u.service).map((u) => u.name).sort(),
      })),
    }
  }

  /** A managed service's minted (suffixed) secret names — names only, derived from the catalog. */
  private mintedManagedNames(m: { type: ManagedDbType; name: string }): string[] {
    return Object.keys(suffixBundle(MANAGED_DB[m.type].bundle('h', 'p'), m.name))
  }

  /** A service's secret names (names only): minted credentials + user secrets bound to it. */
  serviceSecretNames(projectId: string, serviceId: string): string[] {
    const svc = this.serviceOf(projectId, serviceId)
    const list = loadState().userSecrets[projectId] ?? []
    const bound = list.filter((u) => u.service === `${svc.type}/${svc.name}`).map((u) => u.name)
    const minted = svc.type === 'postgres' ? ['DATABASE_URL']
      : svc.type === 'storage' ? Object.keys(this.listBranches(projectId)[0]?.s3 ?? {})
      : isManagedDbType(svc.type) ? this.mintedManagedNames({ type: svc.type, name: svc.name })
      : []
    return [...new Set([...minted, ...bound])].sort()
  }

  /** Structural merge (additive, no data — platform spec §6): materialize on the target branch
   *  every compute group deployed on `from` but absent there, against the TARGET's own db/bucket.
   *  The fixed postgres/storage pair exists on every oss branch, so it always reports as skipped. */
  async mergeBranch(projectId: string, targetName: string, fromName: string): Promise<{
    created: Array<{ type: string; name: string }>
    skipped: Array<{ type: string; name: string; reason: string }>
  }> {
    if (!this.getProject(projectId)) throw new Error('project not found')
    const target = this.getBranchByName(projectId, targetName)
    if (!target) throw new Error(`target branch not found: ${targetName}`)
    const source = this.getBranchByName(projectId, fromName)
    if (!source) throw new Error(`source branch not found: ${fromName}`)
    if (source.id === target.id) throw new Error('source and target are the same branch')

    const created: Array<{ type: string; name: string }> = []
    const skipped: Array<{ type: string; name: string; reason: string }> = [
      { type: 'postgres', name: 'db', reason: 'exists' },
      { type: 'storage', name: 'store', reason: 'exists' },
      // managed databases are project-level registrations materialized on every branch, so the
      // target always already has them (fresh + empty — data never merges anywhere)
      ...this.managedList(projectId).map((m) => ({ type: m.type as string, name: m.name, reason: 'exists' })),
    ]
    for (const [group, app] of Object.entries(source.apps).sort(([a], [b]) => a.localeCompare(b))) {
      if (target.apps[group]) { skipped.push({ type: 'compute', name: group, reason: 'exists' }); continue }
      await this.deployAllocatingPort(projectId, target.name, group, app)
      created.push({ type: 'compute', name: group })
    }
    this.emit(projectId, target.name, 'resource', 'branch.merge', { from: source.name, into: target.name, created: created.length })
    return { created, skipped }
  }

  /** Compute lifecycle (start|stop|suspend): persistent developer intent + best-effort adapter op.
   *  Branch-scoped — oss service ids don't encode a branch, so callers pass one (default branch
   *  otherwise). Returns the service row + live runtime state, the shape the CLI prints. */
  async lifecycle(projectId: string, serviceId: string, verb: 'start' | 'stop' | 'suspend', branchName?: string): Promise<{
    service: Record<string, unknown> | undefined; state: string
  }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    const ref = this.ref(project, branch)
    const desired = verb === 'start' ? 'running' : verb === 'stop' ? 'stopped' : 'suspended'
    let state = 'none'
    if (branch.apps[group]) {
      const op = this.compute[verb]
      if (!op) throw new Error(`${verb} is not supported by this compute adapter`)
      await op.call(this.compute, ref, group).catch(() => { /* best-effort, platform parity */ })
      mutate((s) => { s.branches[branch.id].apps[group].desiredState = desired })
      state = await this.liveState(ref, group)
    }
    this.emit(projectId, branch.name, 'resource', `service.${verb}`, { service: serviceId })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === serviceId)
    return { service, state }
  }

  /** Restart a compute service: re-run the image it ALREADY runs, so the container is recreated
   *  with a freshly assembled env. `docker restart` would replay the env the container was created
   *  with — env reaches a container at `docker run`, exactly as the platform bakes it into machine
   *  config — so a restart that picks up a changed secret has to be a redeploy on both sides.
   *  Refused unless the desired state is 'running', mirroring the platform's refusal. */
  async restart(projectId: string, serviceId: string, branchName?: string): Promise<{
    service: Record<string, unknown> | undefined; state: string
  }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    const app = branch.apps[group]
    if (!app) throw new Error('this service has no machines yet — deploy an image first, then retry')
    const desired = app.desiredState ?? 'running'
    if (desired !== 'running') throw new Error(`this service is ${desired} — start it with \`insta compute start\`, which also re-enables auto-wake`)
    await this.deploy(projectId, branch.name, { image: app.image, port: app.port, hostPort: app.hostPort, group })
    this.emit(projectId, branch.name, 'resource', 'service.restart', { service: serviceId })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === serviceId)
    return { service, state: await this.liveState(this.ref(project, branch), group) }
  }

  /** A compute service's desired (developer intent) vs. live runtime state. */
  async serviceState(projectId: string, serviceId: string, branchName?: string): Promise<{ desiredState: string; state: string }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    const app = branch.apps[group]
    return {
      desiredState: app?.desiredState ?? 'running',
      state: app ? await this.liveState(this.ref(project, branch), group) : 'none',
    }
  }

  /** Set a storage service's bucket access mode (anonymous public-read vs private). */
  async setServiceAccess(projectId: string, serviceId: string, isPublic: boolean, branchName?: string): Promise<Record<string, unknown> | undefined> {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'storage') throw new Error('access control is only supported for storage services')
    const project = this.getProject(projectId)!
    const branch = branchName ? this.getBranchByName(projectId, branchName) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new Error(`branch "${branchName}" not found`)
    if (!this.storage.setAccess) throw new Error('access control is not supported by this storage adapter')
    await this.storage.setAccess(this.ref(project, branch), branch.network, isPublic)
    mutate((s) => { s.branches[branch.id].storagePublic = isPublic })
    this.emit(projectId, branch.name, 'resource', 'service.setAccess', { service: serviceId, public: isPublic })
    return (await this.services(projectId, branch.name)).find((x) => x.id === serviceId)
  }

  // ---- storage objects (platform parity: `insta storage list|get|delete`, console browser) ----

  /** Resolve an object-operation target: a storage service id + the branch's credential env. */
  private objectTarget(projectId: string, serviceId: string, branchName?: string): Branch {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'storage') throw new Error('object operations are only supported for storage services')
    const { branch } = this.branchOrThrow(projectId, branchName)
    return branch
  }

  private objectOps(): Required<Pick<StorageAdapter, 'listBucketObjects' | 'presignObjectGet' | 'presignObjectPost' | 'removeObject' | 'removeObjects'>> {
    const s = this.storage
    if (!s.listBucketObjects || !s.presignObjectGet || !s.presignObjectPost || !s.removeObject || !s.removeObjects) {
      throw new Error('object operations are not supported by this storage adapter')
    }
    return { listBucketObjects: s.listBucketObjects.bind(s), presignObjectGet: s.presignObjectGet.bind(s), presignObjectPost: s.presignObjectPost.bind(s), removeObject: s.removeObject.bind(s), removeObjects: s.removeObjects.bind(s) }
  }

  async listServiceObjects(projectId: string, serviceId: string, opts: { branch?: string; prefix?: string; cursor?: string; limit?: number }): Promise<ObjectListing> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const out = await this.objectOps().listBucketObjects(b.s3, { prefix: opts.prefix, cursor: opts.cursor, limit })
    this.emit(projectId, b.name, 'resource', 'storage.objects.list', { service: serviceId, prefix: opts.prefix ?? null })
    return out
  }

  async presignServiceObjectDownload(projectId: string, serviceId: string, opts: { branch?: string; key: string; disposition?: 'attachment' | 'inline' }): Promise<{ url: string; expiresAt: string }> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().presignObjectGet(b.s3, opts.key, opts.disposition ?? 'attachment')
    this.emit(projectId, b.name, 'resource', 'storage.objects.download', { service: serviceId, key: opts.key })
    return out
  }

  async presignServiceObjectUpload(projectId: string, serviceId: string, opts: { branch?: string; key: string; contentType: string; size: number }): Promise<{ url: string; fields: Record<string, string>; expiresAt: string }> {
    // S3's ceiling for a single POST Object — the signed policy makes the provider enforce it.
    if (!Number.isInteger(opts.size) || opts.size < 0 || opts.size > 5 * 1024 * 1024 * 1024) throw new Error('size must be 0..5GiB (bytes)')
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().presignObjectPost(b.s3, opts.key, opts.contentType, opts.size)
    this.emit(projectId, b.name, 'resource', 'storage.objects.upload', { service: serviceId, key: opts.key, size: opts.size })
    return out
  }

  async deleteServiceObject(projectId: string, serviceId: string, opts: { branch?: string; key: string }): Promise<{ deleted: true }> {
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    await this.objectOps().removeObject(b.s3, opts.key)
    this.emit(projectId, b.name, 'resource', 'storage.objects.delete', { service: serviceId, key: opts.key })
    return { deleted: true }
  }

  async deleteServiceObjects(projectId: string, serviceId: string, opts: { branch?: string; keys: string[] }): Promise<{ deleted: number; failed: Array<{ key: string; message: string }> }> {
    if (opts.keys.length > 1000) throw new Error("keys must hold at most 1000 object keys (S3's DeleteObjects cap)")
    const b = this.objectTarget(projectId, serviceId, opts.branch)
    const out = await this.objectOps().removeObjects(b.s3, opts.keys)
    this.emit(projectId, b.name, 'resource', 'storage.objects.delete', { service: serviceId, count: opts.keys.length })
    return out
  }

  /** Resolve a lifecycle target: a compute service id + branch (default branch unless given). */
  private computeTarget(projectId: string, serviceId: string, branchName?: string): { branch: Branch; group: string } {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('lifecycle control is only supported for compute services')
    const branch = branchName ? this.getBranchByName(projectId, branchName) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new Error(`branch "${branchName}" not found`)
    return { branch, group: svc.name }
  }

  private liveState(ref: string, group: string): Promise<string> {
    return this.compute.state ? this.compute.state(ref, group) : Promise.resolve('unknown')
  }

  /** Bulk runtime health for a branch's compute + postgres + managed databases (storage omitted
   *  — object storage has no runtime), the cloud's shape, from ONE `docker ps -a` read. Local
   *  mapping: running→healthy · paused, or exited on developer intent→standby · exited against a
   *  'running' intent→crashed · restarting/created→starting · no container→none · docker
   *  unreadable→unknown. */
  async runtimeHealth(projectId: string, branchName?: string): Promise<{ services: Array<{ serviceId: string; status: string; machines: number; failing: number }> }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const ref = this.ref(project, branch)
    let states: Map<string, string> | null = null
    try {
      const out = (await docker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}'])).toString()
      states = new Map(out.trim().split('\n').filter(Boolean).map((l) => {
        const [name, state] = l.split('\t')
        return [name, state ?? 'unknown'] as const
      }))
    } catch { /* docker unreadable — every service reports unknown rather than a guess */ }
    const health = (container: string, desired: 'running' | 'stopped' | 'suspended'): { status: string; machines: number; failing: number } => {
      if (!states) return { status: 'unknown', machines: 0, failing: 0 }
      const state = states.get(container)
      if (!state) return { status: 'none', machines: 0, failing: 0 }
      const status = state === 'running' ? 'healthy'
        : state === 'paused' ? 'standby'
        : state === 'restarting' || state === 'created' ? 'starting'
        : desired === 'running' ? 'crashed' : 'standby' // exited/dead against intent = crashed
      return { status, machines: 1, failing: status === 'crashed' ? 1 : 0 }
    }
    return {
      services: [
        { serviceId: 'pg-db', ...health(`io-${ref}-pg`, 'running') },
        ...this.managedList(projectId).map((m) => ({ serviceId: m.id, ...health(managedContainerName(ref, m.type, m.name), 'running') })),
        ...this.computeGroupNames(projectId).map((g) => {
          const app = branch.apps[g]
          if (!app) return { serviceId: `cp-${g}`, status: 'none', machines: 0, failing: 0 }
          return { serviceId: `cp-${g}`, ...health(`io-${ref}-app-${g}`, app.desiredState ?? 'running') }
        }),
      ],
    }
  }

  /** Contract parity with the cloud: `services add postgres|storage` must succeed so one
   *  onboarding script runs on both. insta-oss has exactly one of each per project (auto-
   *  provisioned on create), so this is idempotent — returns the existing fixed service. */
  fixedService(projectId: string, type: 'postgres' | 'storage'): { id: string; type: string; name: string; public?: boolean } {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (type === 'postgres') return { id: 'pg-db', type: 'postgres', name: 'db' }
    const def = this.listBranches(projectId).find((b) => b.isDefault)
    return { id: 'st-store', type: 'storage', name: 'store', public: def?.storagePublic ?? false }
  }

  /** Register a compute group as a service (materializes on first deploy --group <name>).
   *  volumeGib optionally attaches a persistent /data volume; it can also attach any time later
   *  via setServiceVolume (platform #185 parity) and be deleted via removeServiceVolume (data
   *  destroyed) — but never detached. */
  addComputeService(projectId: string, name: string, volumeGib?: number): { id: string; type: string; name: string; volume_gib: number | null } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    if (groups.has(name)) throw new Error(`compute service "${name}" already exists`)
    if (volumeGib !== undefined) {
      if (!Number.isInteger(volumeGib) || volumeGib < 1) throw new Error('volumeGib must be a positive integer (whole Gi)')
      if (volumeGib > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
      if (!this.compute.supportsVolumes) throw new Error('/data volumes are not supported by this compute adapter — use the docker adapter')
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = [...(pr.computeGroups ?? []), name]
      if (volumeGib !== undefined) (pr.computeVolumes ??= {})[name] = { id: randomUUID().slice(0, 8), sizeGib: volumeGib }
    })
    this.emit(projectId, null, 'resource', 'service.added', { type: 'compute', name, ...(volumeGib !== undefined ? { volumeGib } : {}) })
    return { id: `cp-${name}`, type: 'compute', name, volume_gib: volumeGib ?? null }
  }

  /** Rename a compute group everywhere it appears: registration, every branch's deployment
   *  (runtime artifact included, via the adapter), and service-bound user secrets. insta-oss
   *  mints no per-service secret names for compute, so there is nothing to re-key. */
  async renameComputeService(projectId: string, oldName: string, newName: string): Promise<Record<string, unknown> | undefined> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newName)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
    const groups = this.computeGroupNames(projectId)
    if (!groups.includes(oldName)) throw new Error('service not found')
    const current = async (): Promise<Record<string, unknown> | undefined> =>
      (await this.services(projectId)).find((s) => s.id === `cp-${newName}`)
    if (newName === oldName) return current()
    if (groups.includes(newName)) throw new Error(`compute service "${newName}" already exists`)
    const branches = this.listBranches(projectId)
    const deployed = branches.filter((b) => b.apps[oldName])
    if (deployed.length && !this.compute.rename) throw new Error('rename is not supported by this compute adapter')
    for (const b of deployed) await this.compute.rename!(this.ref(project, b), oldName, newName)
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = (pr.computeGroups ?? []).map((g) => (g === oldName ? newName : g))
      // the /data volume record follows the rename; its stable id keeps the docker volume attached
      if (pr.computeVolumes?.[oldName]) {
        pr.computeVolumes[newName] = pr.computeVolumes[oldName]
        delete pr.computeVolumes[oldName]
      }
      for (const b of branches) {
        const app = st.branches[b.id].apps[oldName]
        if (!app) continue
        st.branches[b.id].apps[newName] = app
        delete st.branches[b.id].apps[oldName]
      }
      for (const u of st.userSecrets[projectId] ?? []) {
        if (u.service === `compute/${oldName}`) u.service = `compute/${newName}`
      }
    })
    this.emit(projectId, null, 'resource', 'service.rename', { type: 'compute', from: oldName, to: newName })
    return current()
  }

  /** Remove a compute group: destroy its containers (and /data volumes) on every branch, unregister. */
  async removeComputeService(projectId: string, name: string): Promise<void> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const vol = project.computeVolumes?.[name]
    for (const b of this.listBranches(projectId)) {
      if (!b.apps[name]) continue
      await docker(['rm', '-f', `io-${this.ref(project, b)}-app-${name}`]).catch(() => {})
      if (vol) await docker(['volume', 'rm', '-f', `io-${this.ref(project, b)}-data-${vol.id}`]).catch(() => {})
      mutate((st) => { delete st.branches[b.id].apps[name] })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = (pr.computeGroups ?? []).filter((g) => g !== name)
      if (pr.computeVolumes) delete pr.computeVolumes[name]
    })
    this.emit(projectId, null, 'resource', 'service.removed', { type: 'compute', name })
  }

  // ---- managed databases (redis | mysql | mongodb — cloud parity, platform #235/#236) ----

  private managedRow(m: { id: string; type: ManagedDbType; name: string }): { id: string; type: string; name: string; status: string; port: number; volume_gib: number } {
    return { id: m.id, type: m.type, name: m.name, status: 'ready', port: MANAGED_DB[m.type].port, volume_gib: MANAGED_DB[m.type].volumeGib }
  }

  /** Add a managed database: register on the project and materialize one private container per
   *  branch, each with a fresh password (like the cloud, where every branch gets a fresh app +
   *  empty volume + password — data is never cloned). Cloud deviation, same as compute groups:
   *  oss services are project-level registrations, so the service appears on EVERY branch rather
   *  than only the one it was added on. */
  async addManagedService(projectId: string, type: ManagedDbType, name: string): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(name)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
    if (this.managedList(projectId).some((m) => m.type === type && m.name === name)) throw new Error(`${type} service "${name}" already exists`)
    const wouldMint = this.mintedManagedNames({ type, name })
    const clash = (loadState().userSecrets[projectId] ?? []).find((u) => wouldMint.includes(u.name))
    if (clash) throw new Error(`service would mint secret names already used by user secrets: ${clash.name}`)
    const entry = { id: managedServiceId(type, name), type, name, createdAt: Date.now() }
    const provisioned: Array<{ branch: Branch; password: string }> = []
    try {
      for (const b of this.listBranches(projectId)) {
        const password = randomBytes(32).toString('base64url')
        await this.managedDb.provision(this.ref(project, b), b.network, type, name, password)
        provisioned.push({ branch: b, password })
      }
    } catch (e) {
      for (const p of provisioned) await this.managedDb.destroy(this.ref(project, p.branch), type, name).catch(() => {})
      throw e
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.managedServices = [...(pr.managedServices ?? []), entry]
      for (const p of provisioned) (st.branches[p.branch.id].managed ??= {})[entry.id] = { password: p.password }
    })
    this.emit(projectId, null, 'resource', 'service.added', { type, name })
    return this.managedRow(entry)
  }

  /** Remove a managed database: destroy its container on every branch, unregister. The data goes
   *  with it — same irreversibility class as removing a compute service. */
  async removeManagedService(projectId: string, serviceId: string): Promise<void> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const m = this.managedList(projectId).find((x) => x.id === serviceId)
    if (!m) throw new Error('service not found')
    for (const b of this.listBranches(projectId)) {
      await this.managedDb.destroy(this.ref(project, b), m.type, m.name).catch(() => {})
      mutate((st) => { delete st.branches[b.id].managed?.[serviceId] })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.managedServices = (pr.managedServices ?? []).filter((x) => x.id !== serviceId)
    })
    this.emit(projectId, null, 'resource', 'service.removed', { type: m.type, name: m.name })
  }

  /** Rename a managed database everywhere it appears: registration (the id embeds the name),
   *  every branch's container (docker DNS follows), per-branch credentials (re-keyed by the new
   *  id; the bundle re-mints on the next read with the new host + suffix), and service-bound
   *  user secrets. Deployed compute containers keep the OLD host in their env until their next
   *  deploy — same as the cloud, where a rename re-keys stored names but never hot-patches env. */
  async renameManagedService(projectId: string, serviceId: string, newName: string): Promise<{ id: string; type: string; name: string; status: string; port: number; volume_gib: number }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const m = this.managedList(projectId).find((x) => x.id === serviceId)
    if (!m) throw new Error('service not found')
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(newName)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
    if (newName === m.name) return this.managedRow(m)
    if (this.managedList(projectId).some((x) => x.type === m.type && x.name === newName)) throw new Error(`${m.type} service "${newName}" already exists`)
    const newId = managedServiceId(m.type, newName)
    for (const b of this.listBranches(projectId)) {
      if (!b.managed?.[serviceId]) continue
      await this.managedDb.rename(this.ref(project, b), m.type, m.name, newName)
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.managedServices = (pr.managedServices ?? []).map((x) => (x.id === serviceId ? { ...x, id: newId, name: newName } : x))
      for (const b of Object.values(st.branches)) {
        if (b.projectId !== projectId || !b.managed?.[serviceId]) continue
        b.managed[newId] = b.managed[serviceId]
        delete b.managed[serviceId]
      }
      for (const u of st.userSecrets[projectId] ?? []) {
        if (u.service === `${m.type}/${m.name}`) u.service = `${m.type}/${newName}`
      }
    })
    this.emit(projectId, null, 'resource', 'service.rename', { type: m.type, from: m.name, to: newName })
    return this.managedRow({ id: newId, type: m.type, name: newName })
  }

  // ---- volumes + database settings (tier-caps contract parity — platform #166–169) ----

  /** A compute service's /data volume (null when none) + the volume cap — GET …/volume shape. */
  serviceVolume(projectId: string, serviceId: string): { volume: { sizeGib: number; mountPath: string } | null; cap: { volumeGib: number } } {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    const vol = this.getProject(projectId)?.computeVolumes?.[svc.name]
    return { volume: vol ? { sizeGib: vol.sizeGib, mountPath: VOLUME_MOUNT_PATH } : null, cap: { volumeGib: VOLUME_CAP_GIB } }
  }

  /** Attach or grow a compute service's /data volume — the cloud contract (attach any time,
   *  platform #185; grow-only; ≤ cap) so the CLI flow is identical; the size itself is advisory
   *  locally (a docker named volume has no quota to extend). */
  async setServiceVolume(projectId: string, serviceId: string, sizeGib: number): Promise<{
    service: Record<string, unknown> | undefined; volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean
  }> {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    if (!Number.isInteger(sizeGib) || sizeGib < 1) throw new Error('sizeGib must be a positive integer (whole Gi)')
    if (sizeGib > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
    const vol = this.getProject(projectId)?.computeVolumes?.[svc.name]
    if (!vol) {
      // Attach-after-create (platform #185 parity): record only — the named volume materializes
      // when the NEXT deploy rebuilds the container with the mount, exactly the cloud's "mounts
      // at /data on the next deploy". `attached: true` is what the CLI keys its wording on.
      if (!this.compute.supportsVolumes) throw new Error('/data volumes are not supported by this compute adapter — use the docker adapter')
      mutate((st) => { (st.projects[projectId].computeVolumes ??= {})[svc.name] = { id: randomUUID().slice(0, 8), sizeGib } })
      this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib, attached: true })
      const attachedSvc = (await this.services(projectId)).find((s) => s.id === serviceId)
      return { service: attachedSvc, volume: { sizeGib, mountPath: VOLUME_MOUNT_PATH }, cap: { volumeGib: VOLUME_CAP_GIB }, attached: true }
    }
    if (sizeGib < vol.sizeGib) throw new Error(`the volume can only grow (currently ${vol.sizeGib}Gi) — the volume is a provisioned disk and cannot shrink`)
    if (sizeGib !== vol.sizeGib) {
      mutate((st) => { st.projects[projectId].computeVolumes![svc.name].sizeGib = sizeGib })
      this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib })
    }
    const service = (await this.services(projectId)).find((s) => s.id === serviceId)
    return { service, volume: { sizeGib, mountPath: VOLUME_MOUNT_PATH }, cap: { volumeGib: VOLUME_CAP_GIB } }
  }

  /** Delete a compute service's /data volume — the 2026-08-08 cloud contract (DELETE …/volume):
   *  the only way off the volume path (there is still no detach), destroying the data. EAGER like
   *  the platform: every branch where the group is deployed is rebuilt WITHOUT the mount now (the
   *  record goes first — deploy() reads it), the branch's named volume is removed, and a stopped
   *  service is re-stopped after its rebuild — the same lifecycle-preserving rule the platform
   *  keeps with skip_launch. Docker cleanup is best-effort like removeComputeService's: oss has
   *  no billing, and branch teardown sweeps any stragglers. Non-transactional like the engine's
   *  other multi-branch sweeps: a rebuild that throws mid-loop leaves LATER branches still
   *  mounted with the record already gone — locally a retry or redeploy converges, and nothing
   *  bills meanwhile (John-bot note on this PR). */
  async removeServiceVolume(projectId: string, serviceId: string): Promise<{
    service: Record<string, unknown> | undefined; volume: null; cap: { volumeGib: number }; removed: true
  }> {
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute') throw new Error('volumes are only supported for compute services')
    const project = this.getProject(projectId)
    const vol = project?.computeVolumes?.[svc.name]
    if (!vol) throw new Error('this service has no volume')
    mutate((st) => { delete st.projects[projectId].computeVolumes![svc.name] })
    for (const b of this.listBranches(projectId)) {
      const app = b.apps[svc.name]
      if (!app) continue
      await this.deploy(projectId, b.name, { image: app.image, port: app.port, hostPort: app.hostPort, group: svc.name })
      // Restore the EXACT recorded intent, not a coarser one: unlike the cloud (where a volume
      // forbids suspend), oss allows a suspended volume-bearing service, so delete-from-suspended
      // must land back on 'suspend' — mapping it to 'stop' would silently rewrite desiredState
      // (r2d2 finding on this PR).
      if (app.desiredState === 'stopped' || app.desiredState === 'suspended') {
        await this.lifecycle(projectId, serviceId, app.desiredState === 'suspended' ? 'suspend' : 'stop', b.name).catch(() => {})
      }
      await docker(['volume', 'rm', '-f', `io-${this.ref(project!, b)}-data-${vol.id}`]).catch(() => {})
    }
    this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib: null, removed: true })
    const service = (await this.services(projectId)).find((s) => s.id === serviceId)
    return { service, volume: null, cap: { volumeGib: VOLUME_CAP_GIB }, removed: true }
  }

  /** Read-only DB instance view (DbInstanceInfo shape): settings + volume size + the cap. Local
   *  values are honest constants — pooling/scale-to-zero are cloud provider levers with no
   *  docker-postgres analog. Includes the deprecated storage* aliases the platform still mirrors. */
  dbInstance(projectId: string, branchName?: string): Record<string, unknown> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const gib = branch.dbVolumeGib ?? DB_VOLUME_DEFAULT_GIB
    return {
      id: 'pg-db', name: 'db', state: branch.status,
      host: `io-${this.ref(project, branch)}-pg`, port: 5432,
      connectionPooling: false, deletionProtection: false, scaleToZero: false,
      volumeSize: `${gib}Gi`, volumeGib: gib,
      storageSize: `${gib}Gi`, storageGiB: gib, // DEPRECATED aliases — dropped when the platform drops them
      cap: { ...DB_CAP },
    }
  }

  /** PATCH database/settings: volumeSize ('10Gi', whole Gi, grow-only) is accepted, persisted,
   *  and echoed — advisory locally, the postgres container's disk is unbounded. Other settings
   *  (pooling, scale-to-zero, idle timeout, cpu/memory ceilings) are cloud provider levers with
   *  no local analog: accepted and ignored so one script runs unchanged on both targets. */
  dbSettings(projectId: string, patch: { volumeSize?: string; storageSize?: string }, branchName?: string): Record<string, unknown> {
    const { branch } = this.branchOrThrow(projectId, branchName)
    const raw = patch.volumeSize ?? patch.storageSize // storageSize = deprecated platform alias
    if (raw !== undefined) {
      const m = /^(\d+)Gi$/.exec(String(raw).trim())
      const want = m ? Number(m[1]) : 0
      if (want < 1) throw new Error(`invalid volume quantity: ${raw} (whole Gi only — try '10Gi')`)
      const current = branch.dbVolumeGib ?? DB_VOLUME_DEFAULT_GIB
      if (want < current) throw new Error(`the volume can only grow (currently ${current}Gi) — the volume is a provisioned disk and cannot shrink`)
      if (want > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
      if (want !== current) {
        mutate((st) => { st.branches[branch.id].dbVolumeGib = want })
        this.emit(projectId, branch.name, 'resource', 'database.settings', { volumeSize: `${want}Gi` })
      }
    }
    return this.dbInstance(projectId, branchName)
  }

  // ---- database management (password / databases / extensions / insight — cloud parity) ----

  /** Extensions the daemon itself depends on — installed by the platform, cannot be disabled
   *  (plpgsql is postgres's own default; pg_stat_statements backs `insta` query-stats). */
  private static REQUIRED_EXTENSIONS = ['plpgsql', 'pg_stat_statements']
  private static DB_NAME_RE = /^[A-Za-z0-9._-]+$/
  private quoteIdent(name: string): string { return `"${name.replace(/"/g, '""')}"` }

  /** The branch's connection URL with the database name swapped. */
  private connStringFor(branch: Branch, database: string): string {
    const u = new URL(branch.dbUrl)
    return `${u.protocol}//${u.username}:${u.password}@${u.host}/${database}`
  }

  /** Set or regenerate the postgres user password; re-mints the branch's DATABASE_URL. Deployed
   *  containers keep the old env until their next deploy — same as the cloud. */
  async dbSetPassword(projectId: string, password: string | undefined, branchName?: string): Promise<{ connString: string; password: string }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const pw = password ?? randomBytes(24).toString('base64url')
    await this.db.query(this.ref(project, branch), `alter user postgres with password '${pw.replace(/'/g, "''")}'`)
    const u = new URL(branch.dbUrl)
    const connString = `${u.protocol}//${u.username}:${encodeURIComponent(pw)}@${u.host}${u.pathname}`
    mutate((st) => { st.branches[branch.id].dbUrl = connString })
    this.emit(projectId, branch.name, 'resource', 'db.password.set', { generated: !password })
    return { connString, password: pw }
  }

  async dbListDatabases(projectId: string, branchName?: string): Promise<{ databases: Array<{ name: string; connString: string }> }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const rows = JSON.parse(await this.db.query(this.ref(project, branch), observe.DB_DATABASES_SQL)) as Array<{ name: string }>
    return { databases: rows.map((r) => ({ name: r.name, connString: this.connStringFor(branch, r.name) })) }
  }

  async dbCreateDatabase(projectId: string, name: string, branchName?: string): Promise<{ name: string; connString: string }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    await this.db.query(this.ref(project, branch), `create database ${this.quoteIdent(name)}`)
    this.emit(projectId, branch.name, 'resource', 'db.database.create', { name })
    return { name, connString: this.connStringFor(branch, name) }
  }

  async dbDeleteDatabase(projectId: string, name: string, branchName?: string): Promise<void> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    // 'app' is the local substrate's fixed primary (adapters/postgres.ts DB); the URL-derived
    // name covers adapters that mint a different primary.
    const primary = new URL(branch.dbUrl).pathname.slice(1) || 'app'
    if (name === primary || name === 'app' || name === 'postgres' || name.startsWith('template')) {
      throw new Error(`cannot delete ${name === primary || name === 'app' ? 'the primary database' : 'a system database'} (${name})`)
    }
    // WITH (FORCE): a control plane must not be blocked by an app holding a connection open.
    await this.db.query(this.ref(project, branch), `drop database ${this.quoteIdent(name)} with (force)`)
    this.emit(projectId, branch.name, 'resource', 'db.database.delete', { name })
  }

  /** Installed + available extensions. Local postgres is full-power: `available` is the image's
   *  real pg_available_extensions, not a curated allowlist; the daemon's own two are `required`. */
  async dbExtensions(projectId: string, branchName?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const r = JSON.parse(await this.db.query(this.ref(project, branch), observe.DB_EXTENSIONS_SQL)) as { available: Array<{ name: string }>; enabled: string[] }
    return {
      available: r.available.map((a) => (Engine.REQUIRED_EXTENSIONS.includes(a.name) ? { name: a.name, required: true } : { name: a.name })),
      enabled: r.enabled,
    }
  }

  async dbPatchExtensions(projectId: string, patch: { enable?: string[]; disable?: string[] }, branchName?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const ref = this.ref(project, branch)
    const view = await this.dbExtensions(projectId, branch.name)
    const known = new Set(view.available.map((a) => a.name))
    for (const name of [...(patch.enable ?? []), ...(patch.disable ?? [])]) {
      if (!known.has(name)) throw new Error(`unknown extension: ${name}`)
    }
    for (const name of patch.disable ?? []) {
      if (Engine.REQUIRED_EXTENSIONS.includes(name)) throw new Error(`extension ${name} is required by the platform and cannot be disabled`)
    }
    for (const name of patch.enable ?? []) await this.db.query(ref, `create extension if not exists ${this.quoteIdent(name)}`)
    for (const name of patch.disable ?? []) await this.db.query(ref, `drop extension if exists ${this.quoteIdent(name)}`)
    this.emit(projectId, branch.name, 'resource', 'db.extensions.update', { enable: patch.enable ?? [], disable: patch.disable ?? [] })
    return this.dbExtensions(projectId, branch.name)
  }

  /** Deep database health (DbInsight shape): size breakdown, per-table stats, vacuum health,
   *  unused indexes — same sections the cloud serves, read straight off the branch container. */
  async dbInsight(projectId: string, branchName?: string): Promise<observe.DbInsight> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    return observe.toDbInsight(await this.db.query(this.ref(project, branch), observe.DB_INSIGHT_SQL))
  }

  async destroyBranch(projectId: string, branchId: string): Promise<void> {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot delete the default branch')
    const ref = this.ref(project, b)
    await this.compute.destroy(ref)
    await this.db.destroy(ref)
    await this.storage.destroy(ref, b.network)
    for (const m of this.managedList(projectId)) await this.managedDb.destroy(ref, m.type, m.name).catch(() => {})
    try { await docker(['network', 'rm', b.network]) } catch { /* gone */ }
    mutate((s) => { delete s.branches[branchId] })
    this.emit(projectId, b.name, 'resource', 'branch.deleted', {})
  }

  async destroyProject(projectId: string): Promise<void> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    for (const b of this.listBranches(projectId)) {
      const ref = this.ref(project, b)
      await this.compute.destroy(ref)
      await this.db.destroy(ref)
      await this.storage.destroy(ref, b.network)
      for (const m of this.managedList(projectId)) await this.managedDb.destroy(ref, m.type, m.name).catch(() => {})
      try { await docker(['network', 'rm', b.network]) } catch { /* gone */ }
      mutate((s) => { delete s.branches[b.id] })
    }
    mutate((s) => { delete s.projects[projectId] })
  }

  // ---- observability (docker + SQL backed; cloud response shapes) ----

  /** Resolve a branch (default branch unless named) or throw. */
  private branchOrThrow(projectId: string, branchName?: string): { project: Project; branch: Branch } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branch = branchName ? this.getBranchByName(projectId, branchName) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new Error(`branch "${branchName}" not found`)
    return { project, branch }
  }

  /** The containers an observability request targets: the branch's pg, its compute group(s), or
   *  its managed databases of one type. Each managed type is its OWN component, never folded into
   *  'compute' (cloud parity: names are unique per type, so `group` resolves inside a type, and
   *  the compute fan-out must not absorb database containers). */
  private observedContainers(project: Project, branch: Branch, component: ObservedComponent, group?: string): string[] {
    const ref = this.ref(project, branch)
    if (component === 'db') return [`io-${ref}-pg`]
    if (component !== 'compute') {
      return this.managedList(project.id)
        .filter((m) => m.type === component && (!group || m.name === group) && branch.managed?.[m.id])
        .map((m) => managedContainerName(ref, m.type, m.name))
    }
    const groups = group ? [group] : Object.keys(branch.apps).sort()
    return groups.filter((g) => branch.apps[g]).map((g) => `io-${ref}-app-${g}`)
  }

  /** Runtime logs via `docker logs --tail` — same LogsResult shape as the cloud (which serves
   *  compute from Fly; here BOTH components are real containers, so db logs work too). */
  async runtimeLogs(projectId: string, opts: { component: ObservedComponent; branchName?: string; group?: string; limit?: number }): Promise<observe.LogsResult> {
    const { project, branch } = this.branchOrThrow(projectId, opts.branchName)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const lines: observe.LogLine[] = []
    for (const name of this.observedContainers(project, branch, opts.component, opts.group)) {
      try {
        const raw = (await docker(['logs', '--tail', String(limit), '--timestamps', name], { mergeStderr: true })).toString()
        lines.push(...observe.parseDockerLogs(raw, name))
      } catch { /* container gone — skip rather than fail the whole read */ }
    }
    lines.sort((a, b) => a.ts.localeCompare(b.ts))
    return { source: 'docker-logs', lines: lines.slice(-limit) }
  }

  /** Point-in-time resource metrics via `docker stats --no-stream` — MetricsResult shape. */
  async runtimeMetrics(projectId: string, opts: { component: ObservedComponent; branchName?: string; group?: string }): Promise<observe.MetricsResult> {
    const { project, branch } = this.branchOrThrow(projectId, opts.branchName)
    const names = this.observedContainers(project, branch, opts.component, opts.group)
    if (!names.length) return { source: 'docker-stats', series: [], note: 'nothing deployed on this branch' }
    let raw = ''
    try { raw = (await docker(['stats', '--no-stream', '--format', '{{json .}}', ...names])).toString() }
    catch { return { source: 'docker-stats', series: [], note: 'containers are not running' } }
    return {
      source: 'docker-stats',
      series: observe.statsToSeries(raw, Math.floor(Date.now() / 1000)),
      note: 'point-in-time snapshot from docker stats — from/to/step are ignored locally',
    }
  }

  /** Control-plane operation log (cloud: Neon operations) — here, the resource-event timeline. */
  operations(projectId: string, limit = 20): { operations: observe.DbOperation[] } {
    if (!this.getProject(projectId)) throw new Error('project not found')
    const ops = this.listEvents(projectId)
      .filter((e) => e.source === 'resource')
      .slice(-Math.min(Math.max(limit, 1), 100))
      .reverse()
      .map((e) => ({ id: e.id, action: e.kind, status: 'finished', createdAt: e.createdAt }))
    return { operations: ops }
  }

  /** Point-in-time DB metrics — runs SQL against the branch database (same query as the cloud). */
  async dbMetricsSnapshot(projectId: string, branchName?: string): Promise<observe.DbMetricsSnapshot> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    return observe.toDbMetrics(await this.db.query(this.ref(project, branch), observe.DB_METRICS_SQL))
  }

  /** Currently running queries (pg_stat_activity, ≤100). */
  async dbActivity(projectId: string, branchName?: string): Promise<{ queries: observe.DbActivityRow[] }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    return { queries: observe.toDbActivity(await this.db.query(this.ref(project, branch), observe.DB_ACTIVITY_SQL)) }
  }

  /** Top statements by execution time (pg_stat_statements; preloaded on newly-provisioned branch
   *  databases — older containers report extensionReady:false, exactly like the cloud's
   *  "enabled on demand" path when the extension can't load). */
  async dbQueryStats(projectId: string, branchName: string | undefined, opts: { limit?: number; sort?: observe.QueryStatSort } = {}): Promise<observe.DbQueryStats> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const ref = this.ref(project, branch)
    try {
      await this.db.query(ref, 'create extension if not exists pg_stat_statements')
      const rows = await this.db.query(ref, observe.queryStatsSql(opts.limit ?? 20, opts.sort ?? 'total'))
      return { extensionReady: true, stats: observe.toQueryStats(rows) }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (observe.isExtensionUnavailable(m)) return { stats: [], extensionReady: false }
      throw e
    }
  }

  /** Manifest view: project + branches + per-branch resources (db / compute groups). */
  detail(projectId: string): { project: Record<string, unknown>; branches: Record<string, unknown>[]; resources: Record<string, unknown>[] } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    const resources = branches.flatMap((b) => [
      { kind: 'postgres', name: null, branchId: b.id, ref: { url: b.dbUrl }, status: 'ready' },
      { kind: 'storage', name: null, branchId: b.id, ref: { bucket: b.bucket }, status: 'ready' },
      ...this.managedList(projectId).filter((m) => b.managed?.[m.id]).map((m) => ({
        kind: m.type as string, name: m.name as string | null, branchId: b.id,
        ref: { host: managedContainerName(this.ref(project, b), m.type, m.name), port: MANAGED_DB[m.type].port }, status: 'ready',
      })),
      ...Object.entries(b.apps).map(([group, app]) => (
        { kind: 'compute', name: group, branchId: b.id, ref: { url: app.url, image: app.image }, status: 'ready' }
      )),
    ])
    return {
      project: { id: project.id, name: project.name, status: project.status, org_id: 'local' },
      branches: branches.map((b) => ({ id: b.id, name: b.name, is_default: b.isDefault, status: b.status })),
      resources,
    }
  }
}
