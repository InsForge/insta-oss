// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomUUID } from 'node:crypto'
import { docker } from './docker'
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
    // compute = redeploy: same image, SAME listen port, shifted host mapping (no collision with the source)
    for (const [group, app] of Object.entries(source.apps)) {
      await this.deploy(projectId, name, { image: app.image, port: app.port, hostPort: app.port + 1000, group })
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
    const hostPort = opts.hostPort ?? port
    const { url } = await this.compute.deploy(this.ref(project, b.name), {
      image: opts.image, port, hostPort, network: b.network, group,
      envVars: { ...b.s3, DATABASE_URL: b.dbUrl, ...this.userSecretsFor(projectId, b.name) },
    })
    mutate((s) => { s.branches[b.id].apps[group] = { image: opts.image, port, url } })
    this.emit(projectId, b.name, 'resource', 'deploy', { image: opts.image, group, url })
    return { url, branch: b.name, group }
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

  /** Reserved = platform-minted credential names — user secrets must not clobber them. */
  isReservedSecret(name: string): boolean {
    return name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
      name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')
  }

  setUserSecret(projectId: string, name: string, value: string, branch: string | null): void {
    if (!this.getProject(projectId)) throw new Error('project not found')
    if (this.isReservedSecret(name)) throw new Error(`"${name}" is a reserved platform credential name`)
    if (branch && !this.getBranchByName(projectId, branch)) throw new Error(`branch "${branch}" not found`)
    mutate((st) => {
      const list = (st.userSecrets[projectId] ??= [])
      const existing = list.find((u) => u.name === name && u.branch === branch)
      if (existing) existing.value = value
      else list.push({ name, value, branch } satisfies UserSecret)
    })
    this.emit(projectId, branch, 'govern', 'secrets.write', { name, scope: branch ?? 'project' })
  }

  unsetUserSecret(projectId: string, name: string, branch: string | null): void {
    mutate((st) => {
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => !(u.name === name && u.branch === branch))
    })
    this.emit(projectId, branch, 'govern', 'secrets.unset', { name, scope: branch ?? 'project' })
  }

  // ---- services view (services model parity) ----

  /** The project's services as the CLI expects them: the fixed postgres + storage pair and
   *  one compute service per group (registered or already deployed on the default branch). */
  services(projectId: string): Array<{ id: string; type: string; name: string; status: string; machine_count?: number; domain?: string }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const main = this.listBranches(projectId).find((b) => b.isDefault)
    const groups = new Set<string>(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    return [
      { id: 'pg-db', type: 'postgres', name: 'db', status: 'ready' },
      { id: 'st-store', type: 'storage', name: 'store', status: 'ready' },
      ...[...groups].sort().map((g) => ({
        id: `cp-${g}`, type: 'compute', name: g, status: 'ready', machine_count: 1,
        domain: main?.apps[g]?.url,
      })),
    ]
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
