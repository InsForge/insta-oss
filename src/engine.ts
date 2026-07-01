// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomUUID } from 'node:crypto'
import { docker } from './docker'
import { loadState, mutate } from './state'
import type { Branch, Project, DatabaseAdapter, ComputeAdapter, AuditEvent } from './types'

const DEFAULT_BRANCH = 'main'
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

export class Engine {
  constructor(private db: DatabaseAdapter, private compute: ComputeAdapter) {}

  // Branch ref keys containers/networks: <project-slug>-<branch-name>.
  private ref(project: Project, branch: string): string { return `${slug(project.name)}-${branch}` }
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
    const b: Branch = {
      id: randomUUID(), projectId: project.id, name, isDefault, status: 'ready',
      network, dbUrl: url, cloneOf, createdAt: Date.now(), apps: {},
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
    // compute = redeploy: re-run each of the source's app groups against the clone's db
    for (const [group, app] of Object.entries(source.apps)) {
      await this.deploy(projectId, name, { image: app.image, port: app.port + 1000, group })
    }
    this.emit(projectId, name, 'resource', 'branch.created', { from: source.name })
    return b
  }

  async deploy(projectId: string, branchName: string, opts: { image: string; port?: number; group?: string }): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    const group = opts.group ?? 'default'
    const port = opts.port ?? 8080
    const { url } = await this.compute.deploy(this.ref(project, b.name), {
      image: opts.image, port, network: b.network, group,
      envVars: { DATABASE_URL: b.dbUrl },
    })
    mutate((s) => { s.branches[b.id].apps[group] = { image: opts.image, port, url } })
    this.emit(projectId, b.name, 'resource', 'deploy', { image: opts.image, group, url })
    return { url, branch: b.name, group }
  }

  secrets(projectId: string, branchName: string): Record<string, string> {
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    return { DATABASE_URL: b.dbUrl }
  }

  async destroyBranch(projectId: string, branchId: string): Promise<void> {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot delete the default branch')
    const ref = this.ref(project, b.name)
    await this.compute.destroy(ref)
    await this.db.destroy(ref)
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
