// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomUUID } from 'node:crypto'
import { docker } from './docker'
import * as observe from './observe'
import { loadState, mutate } from './state'
import type { Branch, Project, DatabaseAdapter, ComputeAdapter, StorageAdapter, AuditEvent, UserSecret } from './types'

const DEFAULT_BRANCH = 'main'
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

export class Engine {
  constructor(private db: DatabaseAdapter, private compute: ComputeAdapter, private storage: StorageAdapter) {}

  // Branch ref keys containers/networks: <project-slug>-<branch-name>.
  private ref(project: Project, branch: string): string { return `${slug(project.name)}-${slug(branch)}` }
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
    const { url } = await this.db.provision(this.ref(project, name), network)
    let st: { bucket: string; env: Record<string, string> }
    try { st = await this.storage.provision(this.ref(project, name), network) }
    catch (e) {
      // compensate: don't orphan the db container if storage fails
      await this.db.destroy(this.ref(project, name)).catch(() => {})
      await docker(['network', 'rm', network]).catch(() => {})
      throw e
    }
    const b: Branch = {
      id: randomUUID(), projectId: project.id, name, isDefault, status: 'ready',
      network, dbUrl: url, bucket: st.bucket, s3: st.env, cloneOf, createdAt: Date.now(), apps: {},
    }
    mutate((s) => { s.branches[b.id] = b })
    return b
  }

  async createProject(name: string): Promise<{ project: Project; defaultBranch: Branch }> {
    if (this.listProjects().some((p) => p.name === name)) throw new Error(`project "${name}" already exists`)
    const project: Project = { id: randomUUID(), name, status: 'ready', createdAt: Date.now() }
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
    await this.db.cloneInto(this.ref(project, source.name), this.ref(project, name))
    await this.storage.cloneInto(this.ref(project, source.name), this.ref(project, name), b.network)
    // compute = redeploy: same image, SAME listen port, allocated host mapping.
    for (const [group, app] of Object.entries(source.apps)) {
      await this.deployAllocatingPort(projectId, name, group, app)
    }
    // platform parity: the parent branch's user-defined (branch-scoped) secrets clone onto the new branch
    mutate((st) => {
      const list = st.userSecrets[projectId] ?? []
      const inherited = list.filter((u) => u.branch === source.name).map((u) => ({ ...u, branch: name }))
      st.userSecrets[projectId] = [...list, ...inherited]
    })
    this.emit(projectId, name, 'resource', 'branch.created', { from: source.name })
    return b
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
    const { url } = await this.compute.deploy(this.ref(project, b.name), {
      image: opts.image, port, hostPort, network: b.network, group,
      envVars: { ...b.s3, DATABASE_URL: b.dbUrl, ...this.deploySecretsFor(projectId, b.name, group) },
    })
    mutate((s) => { s.branches[b.id].apps[group] = { image: opts.image, port, hostPort, url, updatedAt: Date.now() } })
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
    return { DATABASE_URL: b.dbUrl, ...b.s3, ...this.userSecretsFor(projectId, branchName) }
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

  /** Reserved = platform-minted credential names — user secrets must not clobber them. */
  isReservedSecret(name: string): boolean {
    return name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
      name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')
  }

  setUserSecret(projectId: string, name: string, value: string, branch: string | null, service: string | null = null): void {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (this.isReservedSecret(name)) throw new Error(`"${name}" is a reserved platform credential name`)
    if (branch && !this.getBranchByName(projectId, branch)) throw new Error(`branch "${branch}" not found`)
    if (service) {
      if (!branch) throw new Error('binding a secret to a service requires a branch')
      const valid = ['postgres/db', 'storage/store', ...this.computeGroupNames(projectId).map((g) => `compute/${g}`)]
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

  /** Every compute group name: registered on the project plus any group already deployed. */
  private computeGroupNames(projectId: string): string[] {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set<string>(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    return [...groups].sort()
  }

  /** Resolve a stable oss service id (pg-db | st-store | cp-<group>) to its type + name. */
  private serviceOf(projectId: string, serviceId: string): { type: 'postgres' | 'storage' | 'compute'; name: string } {
    if (serviceId === 'pg-db') return { type: 'postgres', name: 'db' }
    if (serviceId === 'st-store') return { type: 'storage', name: 'store' }
    if (serviceId.startsWith('cp-') && this.computeGroupNames(projectId).includes(serviceId.slice(3))) {
      return { type: 'compute', name: serviceId.slice(3) }
    }
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
    const ref = branch ? this.ref(project, branch.name) : undefined
    const iso = (ms?: number): string | undefined => (ms ? new Date(ms).toISOString() : undefined)
    const runtimeOf = (container: string): string | undefined =>
      running ? (running.has(container) ? 'online' : 'stopped') : undefined
    return [
      { id: 'pg-db', type: 'postgres', name: 'db', status: 'ready',
        endpoint: ref ? `io-${ref}-pg:5432` : undefined,
        runtime: ref ? runtimeOf(`io-${ref}-pg`) : undefined,
        updated_at: iso(branch?.createdAt) },
      { id: 'st-store', type: 'storage', name: 'store', status: 'ready',
        public: branch?.storagePublic ?? false,
        endpoint: branch ? `io-minio:9000/${branch.bucket}` : undefined,
        runtime: runtimeOf('io-minio'),
        updated_at: iso(branch?.createdAt) },
      ...[...groups].sort().map((g) => {
        const app = branch?.apps[g]
        return {
          id: `cp-${g}`, type: 'compute', name: g, status: 'ready', machine_count: 1,
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
          ...groups.map((g) => ({ type: 'compute', name: g, secrets: bound(b.name, `compute/${g}`).sort() })),
        ],
        unbound: list.filter((u) => u.branch === b.name && !u.service).map((u) => u.name).sort(),
      })),
    }
  }

  /** A service's secret names (names only): minted credentials + user secrets bound to it. */
  serviceSecretNames(projectId: string, serviceId: string): string[] {
    const svc = this.serviceOf(projectId, serviceId)
    const list = loadState().userSecrets[projectId] ?? []
    const bound = list.filter((u) => u.service === `${svc.type}/${svc.name}`).map((u) => u.name)
    const minted = svc.type === 'postgres' ? ['DATABASE_URL']
      : svc.type === 'storage' ? Object.keys(this.listBranches(projectId)[0]?.s3 ?? {})
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
    const ref = this.ref(project, branch.name)
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

  /** A compute service's desired (developer intent) vs. live runtime state. */
  async serviceState(projectId: string, serviceId: string, branchName?: string): Promise<{ desiredState: string; state: string }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    const app = branch.apps[group]
    return {
      desiredState: app?.desiredState ?? 'running',
      state: app ? await this.liveState(this.ref(project, branch.name), group) : 'none',
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
    await this.storage.setAccess(this.ref(project, branch.name), branch.network, isPublic)
    mutate((s) => { s.branches[branch.id].storagePublic = isPublic })
    this.emit(projectId, branch.name, 'resource', 'service.setAccess', { service: serviceId, public: isPublic })
    return (await this.services(projectId, branch.name)).find((x) => x.id === serviceId)
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

  /** Contract parity with the cloud: `services add postgres|storage` must succeed so one
   *  onboarding script runs on both. insta-oss has exactly one of each per project (auto-
   *  provisioned on create), so this is idempotent — returns the existing fixed service. */
  fixedService(projectId: string, type: 'postgres' | 'storage'): { id: string; type: string; name: string; public?: boolean } {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (type === 'postgres') return { id: 'pg-db', type: 'postgres', name: 'db' }
    const def = this.listBranches(projectId).find((b) => b.isDefault)
    return { id: 'st-store', type: 'storage', name: 'store', public: def?.storagePublic ?? false }
  }

  /** Register a compute group as a service (materializes on first deploy --group <name>). */
  addComputeService(projectId: string, name: string): { id: string; type: string; name: string } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    if (groups.has(name)) throw new Error(`compute service "${name}" already exists`)
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = [...(pr.computeGroups ?? []), name]
    })
    this.emit(projectId, null, 'resource', 'service.added', { type: 'compute', name })
    return { id: `cp-${name}`, type: 'compute', name }
  }

  /** Remove a compute group: destroy its containers on every branch, unregister. */
  async removeComputeService(projectId: string, name: string): Promise<void> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    for (const b of this.listBranches(projectId)) {
      if (!b.apps[name]) continue
      await docker(['rm', '-f', `io-${this.ref(project, b.name)}-app-${name}`]).catch(() => {})
      mutate((st) => { delete st.branches[b.id].apps[name] })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = (pr.computeGroups ?? []).filter((g) => g !== name)
    })
    this.emit(projectId, null, 'resource', 'service.removed', { type: 'compute', name })
  }

  async destroyBranch(projectId: string, branchId: string): Promise<void> {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot delete the default branch')
    const ref = this.ref(project, b.name)
    await this.compute.destroy(ref)
    await this.db.destroy(ref)
    await this.storage.destroy(ref, b.network)
    try { await docker(['network', 'rm', this.net(project, b.name)]) } catch { /* gone */ }
    mutate((s) => { delete s.branches[branchId] })
    this.emit(projectId, b.name, 'resource', 'branch.deleted', {})
  }

  async destroyProject(projectId: string): Promise<void> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    for (const b of this.listBranches(projectId)) {
      const ref = this.ref(project, b.name)
      await this.compute.destroy(ref)
      await this.db.destroy(ref)
      await this.storage.destroy(ref, b.network)
      try { await docker(['network', 'rm', this.net(project, b.name)]) } catch { /* gone */ }
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

  /** The containers an observability request targets: the branch's pg, or its compute group(s). */
  private observedContainers(project: Project, branch: Branch, component: 'db' | 'compute', group?: string): string[] {
    const ref = this.ref(project, branch.name)
    if (component === 'db') return [`io-${ref}-pg`]
    const groups = group ? [group] : Object.keys(branch.apps).sort()
    return groups.filter((g) => branch.apps[g]).map((g) => `io-${ref}-app-${g}`)
  }

  /** Runtime logs via `docker logs --tail` — same LogsResult shape as the cloud (which serves
   *  compute from Fly; here BOTH components are real containers, so db logs work too). */
  async runtimeLogs(projectId: string, opts: { component: 'db' | 'compute'; branchName?: string; group?: string; limit?: number }): Promise<observe.LogsResult> {
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
  async runtimeMetrics(projectId: string, opts: { component: 'db' | 'compute'; branchName?: string; group?: string }): Promise<observe.MetricsResult> {
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
    return observe.toDbMetrics(await this.db.query(this.ref(project, branch.name), observe.DB_METRICS_SQL))
  }

  /** Currently running queries (pg_stat_activity, ≤100). */
  async dbActivity(projectId: string, branchName?: string): Promise<{ activity: observe.DbActivityRow[] }> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    return { activity: observe.toDbActivity(await this.db.query(this.ref(project, branch.name), observe.DB_ACTIVITY_SQL)) }
  }

  /** Top statements by execution time (pg_stat_statements; preloaded on newly-provisioned branch
   *  databases — older containers report extensionReady:false, exactly like the cloud's
   *  "enabled on demand" path when the extension can't load). */
  async dbQueryStats(projectId: string, branchName: string | undefined, opts: { limit?: number; sort?: observe.QueryStatSort } = {}): Promise<observe.DbQueryStats> {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const ref = this.ref(project, branch.name)
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
