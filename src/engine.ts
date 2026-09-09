// Project/branch lifecycle over local containers. Mirrors the platform model:
// project → branches (main = default); branch create = provision new stack + copy data +
// redeploy the same app image(s); compute = the user's custom image(s), one per group.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Config } from './config'
import { dataLayout, ensureDirSync, lazyDataDirOps, probedCapabilities } from './datadir'
import { migrateLegacyData } from './datadir-migrate'
import { docker } from './docker'
import { MANAGED_DB, CANONICAL_MANAGED_KEYS, CANONICAL_KEYS, suffixBundle, envSuffix, laneBundle, managedServiceId, managedContainerName, isManagedDbType, parseServiceId, pgContainerName, pgServiceId, storageServiceId, bucketName, appContainerName, dataPaths } from './manageddb'
import * as observe from './observe'
import { loadState, mutate } from './state'
import type { Branch, Project, DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter, ManagedDbType, ObservedComponent, ObjectListing, AuditEvent, UserSecret, DataDirOps, PgTarget, ServiceKey, ServiceLimits, ServiceSettings } from './types'
// ---- region WP2 (router): the router's pure modules feed the seams at the end of this class ----
import { findCertFiles } from './router/certs'
import { checkDns, domainResult, DomainError, normalizeHostname, notAdded, type ComputeDomainResult } from './router/domains'
import { assertHostLabel, bucketsOf, buildTable, databasesOf, hostFor as fqdnFor, hostOnly, labelFor, RESERVED_LABELS, type HostKind } from './router/table'
import type { State } from './state'
// ---- end region WP2 ----
// ---- region WP3 (scheduler) ----
import { DockerRuntime, NoContainerError, Scheduler, type Runtime, type ServiceTarget } from './scheduler'
import { stateRev } from './state'
import { Upstream, type UpstreamLike } from './upstream'
// ---- end region WP3 ----
// ---- region WP5 (templates/parity) ----
import { TemplateCatalog } from './templates/catalog'
import { TemplateExecutor } from './templates/executor'
import { ENV_NAME_RE } from './templates/manifest'
// ---- end region WP5 ----

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

// ---- region WP5 (templates/parity) ----
/** The major version of the postgres image the adapter runs (adapters/postgres.ts IMAGE), served
 *  as the `pg_version` column of a postgres services row. */
const PG_VERSION = 16

/** One row of `GET /projects/:id/services`, and what every add/rename returns. */
export interface ServiceRow {
  id: string
  type: string
  name: string
  status: string
  machine_count?: number
  domain?: string
  endpoint?: string
  runtime?: string
  updated_at?: string
  public?: boolean
  desired_state?: string
  volume_gib?: number | null
  port?: number
  always_on?: boolean
  image?: string
  pg_version?: number
  template_deployment_id?: string
  template_code?: string
}

/** What every DELETE route answers with (decision 50): how many provider objects went, and how
 *  many refused to. `failed` is not an error — a bucket already gone is still gone. */
export interface Teardown { destroyed: number; failed: number }
const newTeardown = (): Teardown => ({ destroyed: 0, failed: 0 })
/** Run one teardown step and count it. */
async function count(t: Teardown, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); t.destroyed++ } catch { t.failed++ }
}
// ---- end region WP5 ----

/** The scheduler surface the engine drives (contract 00 section 1.1). The scaffold ships a no-op
 *  stub (region WP3 below); WP3 replaces it with the real `Scheduler`. */
export interface SchedulerLike {
  register(keys: ServiceKey[]): void
  forget(keys: ServiceKey[]): void
  rekey(from: ServiceKey, to: ServiceKey): void
}

/** Constructor options (contract 00 section 7). Every field has a default so `new Engine(db, compute,
 *  storage, managedDb)` keeps working; main.ts passes what it built at boot. */
export interface EngineOptions {
  cfg?: Config                       // default loadConfig()
  data?: DataDirOps                  // scaffold default: the no-op Engine.NOOP_DATA; WP4 default: new DataDir(cfg)
  router?: { invalidate(): void }    // default no-op; main.ts sets engine.router after constructing the Router (WP2)
  // ---- region WP3 (scheduler) ----
  upstream?: UpstreamLike            // default new Upstream(cfg); ONE instance for runtime, scheduler and router (decision 57)
  runtime?: Runtime                  // default new DockerRuntime(cfg, upstream); tests pass FakeRuntime
  scheduler?: Scheduler              // default: built here over `runtime`, NOT started (main.ts starts it)
  // ---- end region WP3 ----
  // ---- region WP5 (templates/parity) ----
  templates?: TemplateCatalog        // default new TemplateCatalog(cfg.templatesDir)
  // ---- end region WP5 ----
}

export class Engine {
  readonly cfg: Config
  /** Invalidated after every mutate that changes hosts or lanes (decision 54). A public assignable
   *  field: main.ts constructs the Router AFTER the engine and sets it (WP2). */
  router: { invalidate(): void }

  constructor(
    private db: DatabaseAdapter, private compute: ComputeAdapter, private storage: StorageAdapter, private managedDb: ManagedDbAdapter,
    opts: EngineOptions = {},
  ) {
    this.cfg = opts.cfg ?? loadConfig()
    this.data = opts.data ?? Engine.NOOP_DATA
    this.router = opts.router ?? { invalidate() { /* no router until WP2 */ } }
    this.templates = opts.templates ?? new TemplateCatalog(this.cfg.templatesDir)   // WP5 (lazy: reads no file until asked)
    // ---- region WP3 (scheduler) ----
    // ONE Upstream for the runtime, the scheduler and (through `engine.upstream`) the router, so a
    // sleep or a wake invalidates the address the next request would have dialled (decision 57).
    // The scheduler is built here and NOT started: main.ts starts the ticker after the listener is
    // up, and every fake-adapter test drives it on demand with the ticker off.
    this.upstream = opts.upstream ?? new Upstream(this.cfg)
    this.scheduler = opts.scheduler ?? new Scheduler(
      opts.runtime ?? new DockerRuntime(this.cfg, this.upstream),
      this.cfg,
      () => this.serviceTargets(),
      {
        markSlept: (key, at) => { this.markSlept(key, at) },
        emit: (key, kind, payload) => { this.emitForKey(key, kind, payload) },
        booting: () => this.booting,
      },
      this.upstream,
    )
    // ---- end region WP3 ----
  }

  /** Serialize container work per app. `deploy` re-asserts the standing lifecycle intent after
   *  replacing the container, and `lifecycle` changes that intent — both read state, then act on the
   *  container across an await. Interleaved, they leave the row and the container disagreeing in
   *  whichever direction lost the race: a `start` landing mid-deploy is recorded and then undone by
   *  the deploy's re-assert. One chain per app, so unrelated services and branches stay concurrent.
   *  Chained on settle, not success — a failed op must not wedge every later one behind it. */
  private appChains = new Map<string, Promise<unknown>>()
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.appChains.get(key) ?? Promise.resolve()).then(fn, fn)
    this.appChains.set(key, next.catch(() => undefined))
    return next
  }

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

  /** The postgres handle of ONE database service on a branch: READ from the row (decision 17); a
   *  row provisioned before the data migration still runs today's `io-<ref>-pg` container. */
  private pgContainer(project: Project, branch: Branch, serviceId = 'pg-db'): string {
    const row = this.dbHandle(project, branch, serviceId)
    if (row) return row.container
    const reg = this.dbList(project.id).find((d) => d.id === serviceId)
    return pgContainerName(this.ref(project, branch), reg?.name ?? 'db')
  }
  /** The bucket handle of ONE storage service on a branch (legacy rows carry `io-<ref>`). */
  private bucketOf(project: Project, branch: Branch, serviceId = 'st-store'): string {
    const row = this.bucketHandle(project, branch, serviceId)
    if (row) return row.bucket
    const reg = this.stList(project.id).find((s) => s.id === serviceId)
    return bucketName(this.ref(project, branch), reg?.name ?? 'store')
  }

  /** Provision one branch stack. `source` null = fresh (initdb); a Branch = fork its database
   *  (adapter-level: reflink or dump/restore). `branchId` is minted by the caller so the lane
   *  reservation and the op lock have an owner from the start (decision 51). WP5 rewrites this method
   *  over registrations; the hooks it calls (contract 7.2) are already in place. */
  private async provisionBranch(project: Project, name: string, isDefault: boolean, source: Branch | null, branchId: string): Promise<Branch> {
    const network = this.net(project, name)
    try { await docker(['network', 'create', network]) } catch (e) {
      // Stock dockerd hands out only 31 user-defined networks from its default pools and every
      // branch is one, so this is the failure a busy box hits first. Anything else here is the
      // network already existing (an interrupted create, or a re-provision).
      const m = e instanceof Error ? e.message : String(e)
      if (/non-overlapping IPv4 address pool/i.test(m)) {
        throw new Error('docker has no free network subnets; see docs/self-hosting/install (default-address-pools)')
      }
    }
    const ref = this.ref(project, name)
    const dbs = this.dbList(project.id)
    const stores = this.stList(project.id)
    const managedRegs = this.managedList(project.id)
    // Check every hostname this branch will mint and reserve every lane port it needs BEFORE the
    // first provisioning await, inside the engine-wide provision chain (decision 51). The check
    // itself writes nothing, so it stays out of a mutate: the chain is what makes it atomic.
    for (const d of dbs) this.assertHostFree(this.labelFor('postgres', d.name, ref))
    for (const m of managedRegs) this.assertHostFree(this.labelFor(m.type, m.name, ref))
    const lanes = this.allocLanes(project, branchId, this.branchServiceIds(project))                      // WP2
    // Every provider object this call created, so one compensation path can undo the whole stack.
    const madeDbs: PgTarget[] = []
    const madeBuckets: string[] = []
    const madeManaged: string[] = []
    const rollback = async (): Promise<void> => {
      for (const c of madeManaged) await this.managedDb.destroy(c).catch(() => {})
      for (const b of madeBuckets) await this.storage.destroy(b, network).catch(() => {})
      for (const d of madeDbs) await this.db.destroy(d.container).catch(() => {})
      // A half-written data directory must not survive to be cloned over (WP4).
      for (const root of this.layout().branchRoots(ref)) await this.data.remove(root).catch(() => {})
      await docker(['network', 'rm', network]).catch(() => {})
      this.releaseLanes(branchId)                                                                         // WP2
    }
    const databases: NonNullable<Branch['databases']> = {}
    const buckets: NonNullable<Branch['buckets']> = {}
    const managed: NonNullable<Branch['managed']> = {}
    try {
      // Postgres: one container per registered service, forked from the source's own file copy
      // when this is a clone (adapter-level: reflink or a streamed basebackup).
      for (const d of dbs) {
        const dst: PgTarget = { container: pgContainerName(ref, d.name), network, dataDir: this.layout().pg(ref, d.dataId) }
        const opts = { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, d.id) }
        const src = source ? this.dbHandle(project, source, d.id) : undefined
        let url: string
        if (source && src) {
          this.assertMigrated(source)                                                                     // WP4
          const srcRef = this.ref(project, source)
          const forked = await this.db.fork(
            { container: src.container, network: source.network, dataDir: this.layout().pg(srcRef, src.dataId), url: src.url },
            dst,
            // WP3 hook: a sleeping source is woken before a basebackup-style fork reads it.
            { ...opts, ensureSourceRunning: () => this.wake(this.serviceKey(source, d.id), { door: 'api' }) },
          )
          url = forked.url
          // WP4: the copy method and duration travel to the branch.created payload (decision 39).
          // The oldest service's fork is the one the event reports.
          if (!this.forkResults.has(branchId)) this.forkResults.set(branchId, { method: forked.method, ms: forked.ms })
        } else {
          // A fresh branch, or a service the source branch never materialised: initdb.
          url = (await this.db.provision(dst, opts)).url
        }
        madeDbs.push(dst)
        databases[d.id] = { url, container: dst.container, dataId: d.dataId, host: this.hostFor('postgres', d.name, ref) }
      }
      // Storage: one bucket per registered service. The objects themselves copy in createBranch.
      for (const s of stores) {
        const out = await this.storage.provision(ref, network, s.name)
        madeBuckets.push(out.bucket)
        if (s.public === true && this.storage.setAccess) await this.storage.setAccess(out.bucket, network, true)
        buckets[s.id] = { bucket: out.bucket, env: out.env, ...(s.public !== undefined ? { public: s.public } : {}) }
      }
      // Managed databases: every branch gets a FRESH empty instance with a fresh password — no data
      // clones from the parent (cloud parity: platform materialize() for managed Fly databases).
      for (const m of managedRegs) {
        const password = randomBytes(32).toString('base64url')
        const container = managedContainerName(ref, m.type, m.name)
        // WP4: `md/<ref>/<prefix>-<dataId>` plus one sub-directory per path the image writes, all
        // created before the container starts (a missing bind source fails the start).
        const dataDir = await this.ensureManagedDirs(ref, m.type, m.dataId ?? m.name)
        await this.managedDb.provision(
          { container, network, type: m.type, name: m.name, password, dataDir },
          { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, m.id) },
        )
        madeManaged.push(container)
        managed[m.id] = { password, host: this.hostFor(m.type, m.name, ref) }
      }
    } catch (e) {
      await rollback()
      throw e
    }
    const b: Branch = {
      id: branchId, projectId: project.id, name, isDefault, status: 'ready', ref,
      network, cloneOf: source?.name ?? null, createdAt: Date.now(), apps: {},
      // Handles are recorded at provision and READ afterwards (decision 17). New branches carry no
      // legacy dbUrl/bucket/s3 fields at all: migrateState derives those rows for OLD branches, and
      // nothing reads them once a branch has its own.
      databases, buckets,
      ...(Object.keys(managed).length ? { managed } : {}),
      ...(Object.keys(lanes).length ? { lanes } : {}),
      dataVersion: 1,                                                                                     // WP4
    }
    // The same mutate that writes the row drops the lane reservations it supersedes.
    mutate((s) => {
      s.branches[b.id] = b
      for (const [port, owner] of Object.entries(s.laneReservations ?? {})) {
        if (owner === branchId) delete s.laneReservations![port]
      }
    })
    // WP3 hook: the scheduler learns the branch's database keys (no-op stub until WP3).
    this.scheduler.register([...Object.keys(databases), ...Object.keys(managed)].map((sid) => this.serviceKey(b, sid)))
    this.router.invalidate()
    return b
  }

  /** Create a project and its default branch. EMPTY, like the cloud (`resources: []`): nothing is
   *  registered, so `provisionBranch` provisions nothing and the caller adds services next. */
  async createProject(name: string): Promise<{ project: Project; defaultBranch: Branch }> {
    return this.serialize('provision', async () => {
      const project: Project = { id: randomUUID(), name, status: 'ready', createdAt: Date.now(), refSlug: slug(name) }
      // Both uniqueness checks and the insert in ONE synchronous mutate, inside the provision
      // chain: two concurrent creates of the same name or slug cannot both pass the check
      // (decision 51). Slugs are frozen per project and outlive renames, so a NEW project must not
      // reuse one — its containers would collide with resources a renamed project still owns.
      mutate((s) => {
        for (const p of Object.values(s.projects)) {
          if (p.name === name) throw new Error(`project "${name}" already exists`)
          if (this.projectSlug(p) === project.refSlug) {
            throw new Error(`project ref "${project.refSlug}" already exists (a renamed project still owns its original resource names)`)
          }
        }
        s.projects[project.id] = project
      })
      try {
        const defaultBranch = await this.provisionBranch(project, DEFAULT_BRANCH, true, null, randomUUID())
        this.emit(project.id, DEFAULT_BRANCH, 'resource', 'project.created', { name })
        return { project, defaultBranch }
      } catch (e) {
        // compensate: never leave a half-provisioned project behind
        mutate((s) => { delete s.projects[project.id] })
        throw e
      }
    })
  }

  async createBranch(projectId: string, name: string, from?: string): Promise<Branch> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const source = this.getBranchByName(projectId, from ?? DEFAULT_BRANCH)
    if (!source) throw new Error(`source branch "${from ?? DEFAULT_BRANCH}" not found`)
    if (this.getBranchByName(projectId, name)) throw new Error(`branch "${name}" already exists`)

    // The new branch's id is minted FIRST, so its ServiceKeys exist before any container op
    // (decision 51). The lock covers the source's services (the fork reads them, and a sleeping one
    // is woken) and the clone's databases (provision, then sleep). The clone's COMPUTE keys are
    // deliberately not held here: the redeploy loop below acquires each one itself, and those
    // containers do not exist yet, so there is nothing for this lock to exclude — while holding
    // them would mean the nested deploy has to re-enter the same key.
    const branchId = randomUUID()
    const ids = this.branchServiceIds(project)
    const keys = [
      ...ids.map((sid) => `${source.id}:${sid}`),
      ...Object.keys(source.apps).map((g) => `${source.id}:cp-${g}`),
      ...ids.map((sid) => `${branchId}:${sid}`),
    ]
    return this.withOp(keys, () => this.createBranchLocked(project, name, source, branchId))
  }

  private async createBranchLocked(project: Project, name: string, source: Branch, branchId: string): Promise<Branch> {
    const projectId = project.id
    // Each database forks inside provisionBranch (db.fork); each bucket copies here; compute redeploys.
    const b = await this.serialize('provision', () => this.provisionBranch(project, name, false, source, branchId))
    // WP4 hook: /data volumes fork BEFORE the redeploy loop, so each new container starts on its
    // own copy rather than sharing the source's bytes.
    const volumes = await this.forkVolumes(project, source, b)
    for (const s of this.stList(projectId)) {
      const from = this.bucketHandle(project, source, s.id)
      const to = this.bucketHandle(project, b, s.id)
      if (from && to) await this.storage.cloneInto(from.bucket, to.bucket, b.network)
    }
    // compute = redeploy: same image, SAME listen port, allocated host mapping.
    for (const [group, app] of Object.entries(source.apps)) {
      // WP3 hook: a clone of a non-always-on service starts asleep (false until the scheduler lands).
      await this.deployAllocatingPort(projectId, name, group, app, { startAsleep: this.startAsleepFor(project, b, group) })
    }
    // platform parity: the parent branch's user-defined (branch-scoped) secrets clone onto the new
    // branch, and so do its bindings (a template's platform credential renames must survive a fork).
    mutate((st) => {
      const list = st.userSecrets[projectId] ?? []
      const inherited = list.filter((u) => u.branch === source.name).map((u) => ({ ...u, branch: name }))
      st.userSecrets[projectId] = [...list, ...inherited]
      if (source.bindings?.length) st.branches[b.id].bindings = source.bindings.map((x) => ({ ...x }))
      // the DB volume-size setting travels with the clone (it describes the copied database)
      if (source.dbVolumeGib !== undefined) st.branches[b.id].dbVolumeGib = source.dbVolumeGib
    })
    // WP3 hook: the clone's databases sleep until first use (no-op until the scheduler lands).
    await this.sleepNewBranch(project, b)
    // WP4: how the database and each /data volume were copied (decision 39), so `insta events`
    // shows whether the box reflinked or fell back to streaming and copying.
    const db = this.forkResults.get(b.id)
    this.forkResults.delete(b.id)
    this.emit(projectId, name, 'resource', 'branch.created', { from: source.name, ...(db ? { db } : {}), volumes })
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

  async deploy(projectId: string, branchName: string, opts: { image: string; port?: number; hostPort?: number; group?: string; startAsleep?: boolean }): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const b = this.getBranchByName(projectId, branchName)
    if (!b) throw new Error(`branch "${branchName}" not found`)
    const group = opts.group ?? 'default'
    return this.withOp([this.serviceKey(b, `cp-${group}`)], () => this.deployLocked(projectId, b.id, group, opts))
  }

  // Takes a branch ID, not a Branch: anything read before the chain is a pre-queue snapshot, and an
  // op that ran ahead of this one has already moved it (its image, its host mapping, its intent).
  // The adapter argument object is assembled through the owner hooks of contract 7.2 (WP2 host
  // port/aliases/containerize/url, WP3 limits/afterDeploy, WP4 volume, WP5 envFor): those packages
  // replace hook bodies in their regions and never edit this method again.
  private async deployLocked(
    projectId: string, branchId: string, group: string,
    opts: { image: string; port?: number; hostPort?: number; startAsleep?: boolean },
  ): Promise<{ url: string; branch: string; group: string }> {
    const project = this.getProject(projectId)!
    const b = loadState().branches[branchId]
    if (!b) throw new Error('branch not found')
    const port = opts.port ?? 8080
    // The group's /data volume, if one was attached at service creation. Named per-branch (each
    // branch is isolated; a clone starts with an EMPTY volume — compute state lives in db/storage)
    // and keyed by the volume's stable id so a service rename never detaches the data.
    const vol = project.computeVolumes?.[group]
    if (vol && !this.compute.supportsVolumes) {
      throw new Error(`service "${group}" has a /data volume, which this compute adapter does not support — use the docker adapter`)
    }
    // Read before the container work, not only after: the adapter can then decline to start a
    // replacement whose standing intent is STOPPED, instead of running it and being stopped a moment
    // later. Safe to read here — the chain means nothing else is moving it.
    //
    // Only 'stopped'. A suspended service's replacement must START: suspend is `docker pause`, and
    // a container that was created and never started cannot be paused — the pause fails, the
    // container stays `created`, and state() reports it `stopped`, contradicting the intent the
    // re-assert just preserved. The brief run is the cost of suspend being a pause.
    const standing = b.apps[group]?.desiredState
    const key = this.serviceKey(b, `cp-${group}`)
    const hostPort = this.localHostPort(b, group, { hostPort: opts.hostPort, port })
    const started = standing !== 'stopped' && !opts.startAsleep
    const { url: adapterUrl } = await this.compute.deploy(this.ref(project, b), {
      image: opts.image, port, network: b.network, group,
      hostPort,                                                    // WP2 (local mode only)
      hostAliases: this.hostAliasesFor(project, b),                // WP2
      volume: this.volumeMount(project, b, group),                 // WP4
      limits: this.limitsFor(project, `cp-${group}`),              // WP3
      // minted credentials (db + storage + managed databases) reach every compute deploy; user
      // secrets are scoped (project-wide + branch-unbound + bound to THIS group)
      envVars: this.containerize(this.envFor(project, b, group)), // WP5 envFor, WP2 containerize
      start: started,
    })
    // The recorded URL is the serviceUrl hook's (WP2: the router URL, deterministic before deploy);
    // the scaffold body reads the adapter's informational url off the row about to be written.
    const url = this.serviceUrl(project, { ...b, apps: { ...b.apps, [group]: { ...b.apps[group], image: opts.image, port, hostPort, url: adapterUrl } } }, group)
    // Spread, not replace: desiredState is the user's standing intent and this write is not the
    // place to clear it. A `stop` landing while a deploy is in flight would otherwise be undone by
    // the deploy's own state write — and `restart` makes that reachable from an operation that
    // checked the intent moments earlier. Matches the platform, whose desired_state survives a deploy.
    const host = this.mintedHost(project, b, group)                                                     // WP2
    mutate((s) => { s.branches[b.id].apps[group] = { ...s.branches[b.id].apps[group], image: opts.image, port, hostPort, url, ...(host !== undefined ? { host } : {}), updatedAt: Date.now() } })
    // ...and the container has to HONOUR that intent, or preserving it just makes the row lie:
    // DockerCompute.deploy always `docker run`s the replacement, so a service the user stopped would
    // come back up while the row still read `stopped`. Re-assert on the container only — the state
    // is already right and must not be rewritten, and the EXACT verb matters (oss allows a suspended
    // volume-bearing service, so suspend must not be coarsened to stop). Best-effort, like the
    // adapter ops in lifecycle(): the deploy itself has already succeeded.
    // Re-assert anyway: `start` is a hint an adapter may ignore, and this is the guarantee.
    if (standing === 'stopped' || standing === 'suspended') {
      const op = standing === 'suspended' ? this.compute.suspend : this.compute.stop
      await op?.call(this.compute, this.ref(project, b), group).catch(() => { /* best-effort */ })
    }
    this.afterDeploy(key, { started, startAsleep: opts.startAsleep }) // WP3
    this.router.invalidate()                                          // WP2
    this.emit(projectId, b.name, 'resource', 'deploy', { image: opts.image, group, url })
    return { url, branch: b.name, group }
  }

  /** Deploy an app spec onto a branch with an allocated host mapping. The naive parent+1000
   *  collides as soon as a second branch exists (or the OS holds the port — e.g. macOS AirPlay
   *  on 5000), so allocate from state and retry on bind failures. */
  private async deployAllocatingPort(projectId: string, branchName: string, group: string, app: { image: string; port: number }, extra: { startAsleep?: boolean } = {}): Promise<void> {
    let lastErr: unknown
    for (const candidate of this.freeHostPorts(app.port, 5)) {
      try {
        await this.deploy(projectId, branchName, { image: app.image, port: app.port, hostPort: candidate, group, ...extra })
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
    return { ...this.mintedSecretsFor(projectId, b), ...this.userSecretsFor(projectId, branchName) }
  }

  /** The branch's minted credentials: every postgres DSN, every S3 bundle and every
   *  managed-database bundle, each SUFFIXED with its service name, the oldest of each type also
   *  under the canonical unsuffixed keys. Bindings are NOT here: they are per target group. */
  private mintedSecretsFor(projectId: string, b: Branch): Record<string, string> {
    const project = this.getProject(projectId)
    if (!project) return {}
    return { ...this.dbSecretsFor(project, b), ...this.storageSecretsFor(project, b), ...this.managedSecretsFor(projectId, b) }
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
      const valid = [
        ...this.dbList(projectId).map((d) => `postgres/${d.name}`),
        ...this.stList(projectId).map((s) => `storage/${s.name}`),
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

  /** Remove a user secret. `service` narrows the removal to a secret bound to THAT service, which
   *  is what the template executor's authoritative env replace needs: a stale name it wrote onto
   *  one compute group must go without touching a same-named secret on another. */
  unsetUserSecret(projectId: string, name: string, branch: string | null, service?: string | null): void {
    mutate((st) => {
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => !(
        u.name === name && u.branch === branch && (service === undefined || (u.service ?? null) === service)
      ))
    })
    this.emit(projectId, branch, 'govern', 'secrets.unset', { name, scope: branch ?? 'project' })
  }

  // ---- services view (services model parity) ----

  /** host:port of the S3 server one storage service was minted against (its own credential, so a
   *  bucket provisioned by an older adapter still reports the server it actually answers on). */
  private s3Host(project: Project, b: Branch, serviceId = 'st-store'): string | undefined {
    try { return new URL(this.bucketHandle(project, b, serviceId)?.env.AWS_ENDPOINT_URL_S3 ?? '').host } catch { return undefined }
  }

  /** Every compute group name: registered on the project plus any group already deployed. */
  private computeGroupNames(projectId: string): string[] {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const groups = new Set<string>(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    return [...groups].sort()
  }

  /** The project's registered managed databases (empty when none). `dataId` is WP4's immutable
   *  directory key (decision 16); rows from before the data dir carry none until the boot migration
   *  backfills one. */
  private managedList(projectId: string): Array<{ id: string; type: ManagedDbType; name: string; createdAt: number; dataId?: string }> {
    return this.getProject(projectId)?.managedServices ?? []
  }

  /** Resolve a service id (`pg-<name>` | `st-<name>` | `cp-<group>` | `rd/my/mo-<name>`, with or
   *  without a `<branchId>:` qualifier) to its type + name, checked against the project's
   *  registrations. An id no registration claims is a 404. */
  private serviceOf(projectId: string, serviceId: string): { type: 'postgres' | 'storage' | 'compute' | ManagedDbType; name: string } {
    const parsed = parseServiceId(serviceId)
    if (!parsed) throw new Error('service not found')
    const { type, name } = parsed
    const known = type === 'postgres' ? this.dbList(projectId).some((d) => d.id === parsed.serviceId)
      : type === 'storage' ? this.stList(projectId).some((s) => s.id === parsed.serviceId)
        : type === 'compute' ? this.computeGroupNames(projectId).includes(name)
          : this.managedList(projectId).some((m) => m.id === parsed.serviceId)
    if (!known) throw new Error('service not found')
    return { type, name }
  }

  /** The project's services as the CLI expects them: one row per registration (postgres, storage,
   *  managed database) plus one per compute group (registered or already deployed on the branch).
   *  Additive dashboard fields (never touching `status`, which the CLI prints): `runtime` from live
   *  docker ps, `domain`/`endpoint`, `always_on`, `template_*`, `updated_at`. Branch-aware via
   *  `branchName` (defaults to the default branch); OFF the default branch every row id carries the
   *  `<branchId>:` qualifier, because the CLI calls the follow-up route with no branch (decision 49). */
  async services(projectId: string, branchName?: string): Promise<ServiceRow[]> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const branches = this.listBranches(projectId)
    const branch = branchName ? branches.find((b) => b.name === branchName) : branches.find((b) => b.isDefault)
    if (branchName && !branch) throw new Error(`branch "${branchName}" not found`)
    const groups = new Set<string>(this.computeGroupNames(projectId))
    // ONE docker read per listing, through the scheduler's Runtime seam: `rowRuntime` and the
    // object-store row then read that snapshot (decision 53 — there is no second `docker ps`).
    await this.scheduler.refreshStates()
    const iso = (ms?: number): string | undefined => (ms ? new Date(ms).toISOString() : undefined)
    const rt = (serviceId: string): string | undefined => (branch ? this.rowRuntime(this.serviceKey(branch, serviceId)) : undefined)
    const id = (serviceId: string): string => (branch ? this.qualifiedId(branch, serviceId) : serviceId)
    const settings = (serviceId: string): ServiceSettings => project.serviceSettings?.[serviceId] ?? {}
    return [
      ...this.dbList(projectId).map((d) => ({
        id: id(d.id), type: 'postgres', name: d.name, status: 'ready', pg_version: PG_VERSION,
        ...this.rowNetwork(project, branch, { id: d.id, type: 'postgres', name: d.name }),
        runtime: rt(d.id),
        ...(d.templateDeploymentId ? { template_deployment_id: d.templateDeploymentId } : {}),
        updated_at: iso(d.createdAt),
      })),
      // Storage endpoint/container derive from the branch's OWN minted creds, so branches
      // provisioned by an older storage adapter still report their real server.
      ...this.stList(projectId).map((s) => ({
        id: id(s.id), type: 'storage', name: s.name, status: 'ready',
        public: (branch ? this.bucketHandle(project, branch, s.id)?.public : s.public) ?? s.public ?? false,
        ...this.rowNetwork(project, branch, { id: s.id, type: 'storage', name: s.name }),
        runtime: branch ? this.runtimeOf(this.s3Host(project, branch, s.id)?.split(':')[0] ?? '') : undefined,
        updated_at: iso(s.createdAt),
      })),
      // Managed databases (redis/mysql/mongodb): one private container per branch. `port` +
      // `volume_gib` are what the CLI renders (`tcp/6379  vol 1Gi`); the volume size is the
      // cloud's fixed 1Gi, advisory locally like every other recorded size.
      ...this.managedList(projectId).map((m) => ({
        id: id(m.id), type: m.type, name: m.name, status: 'ready',
        port: MANAGED_DB[m.type].port, volume_gib: MANAGED_DB[m.type].volumeGib,
        always_on: branch ? this.effectiveAlwaysOn(project, branch, m.id) : undefined,
        ...this.rowNetwork(project, branch, { id: m.id, type: m.type, name: m.name }),
        runtime: rt(m.id),
        updated_at: iso(m.createdAt),
      })),
      ...[...groups].sort().map((g) => {
        const app = branch?.apps[g]
        const cfgd = settings(`cp-${g}`)
        return {
          id: id(`cp-${g}`), type: 'compute', name: g, status: 'ready', machine_count: 1,
          volume_gib: project.computeVolumes?.[g]?.sizeGib ?? null, // platform Service.volume_gib (compute only)
          desired_state: app?.desiredState ?? 'running',
          always_on: branch ? this.effectiveAlwaysOn(project, branch, `cp-${g}`) : undefined,
          ...(app?.image !== undefined ? { image: app.image } : {}),
          ...(app?.port ?? cfgd.port ? { port: app?.port ?? cfgd.port } : {}),
          ...(cfgd.templateDeploymentId ? { template_deployment_id: cfgd.templateDeploymentId } : {}),
          ...(cfgd.templateCode ? { template_code: cfgd.templateCode } : {}),
          ...this.rowNetwork(project, branch, { id: `cp-${g}`, type: 'compute', name: g }),
          runtime: branch ? rt(`cp-${g}`) : app ? undefined : 'none',
          updated_at: iso(app?.updatedAt),
        }
      }),
    ]
  }

  /** The `runtime` column of a row that has no ServiceKey (the object store): the last snapshot the
   *  scheduler took, read by container name. A name docker has never listed is not running. */
  private runtimeOf(container: string): string | undefined {
    if (!container) return undefined
    return this.scheduler.containerState(container) === 'running' ? 'online' : 'stopped'
  }

  /** Names-only secret inventory as project→branch→service→secrets (SecretTree contract shape).
   *  Minted credential names sit under their service (DATABASE_URL → postgres, AWS_* / BUCKET_NAME
   *  → storage), matching the cloud, where minted secrets are service-bound rows. */
  secretTree(projectId: string): {
    projectWide: string[]
    branches: Array<{ name: string; isDefault: boolean; services: Array<{ type: string; name: string; secrets: string[] }>; unbound: string[] }>
  } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const list = loadState().userSecrets[projectId] ?? []
    const groups = this.computeGroupNames(projectId)
    const bound = (branch: string, service: string): string[] =>
      list.filter((u) => u.branch === branch && u.service === service).map((u) => u.name)
    // A binding is a name this group's env carries too, so the inventory lists it under the TARGET
    // group (where it appears) rather than under the service it reads from.
    const boundIn = (b: Branch, group: string): string[] =>
      (b.bindings ?? []).filter((x) => x.target === `compute/${group}`).map((x) => x.envName)
    return {
      projectWide: list.filter((u) => u.branch === null).map((u) => u.name).sort(),
      branches: this.listBranches(projectId).map((b) => ({
        name: b.name,
        isDefault: b.isDefault,
        services: [
          ...this.dbList(projectId).map((d) => ({
            type: 'postgres', name: d.name,
            secrets: [...this.mintedNamesOf(project, d.id), ...bound(b.name, `postgres/${d.name}`)].sort(),
          })),
          ...this.stList(projectId).map((s) => ({
            type: 'storage', name: s.name,
            secrets: [...this.mintedNamesOf(project, s.id), ...bound(b.name, `storage/${s.name}`)].sort(),
          })),
          ...this.managedList(projectId).map((m) => ({
            type: m.type, name: m.name,
            secrets: [...this.mintedManagedNames(m), ...bound(b.name, `${m.type}/${m.name}`)].sort(),
          })),
          ...groups.map((g) => ({ type: 'compute', name: g, secrets: [...bound(b.name, `compute/${g}`), ...boundIn(b, g)].sort() })),
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
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const { serviceId: sid } = this.resolveSid(projectId, serviceId)
    const svc = this.serviceOf(projectId, sid)
    const list = loadState().userSecrets[projectId] ?? []
    const bound = list.filter((u) => u.service === `${svc.type}/${svc.name}`).map((u) => u.name)
    return [...new Set([...this.mintedNamesOf(project, sid), ...bound])].sort()
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
    // Every non-compute service is a project-level registration materialized on every branch, so
    // the target always already has it (fresh + empty for managed databases — data never merges).
    const skipped: Array<{ type: string; name: string; reason: string }> = [
      ...this.dbList(projectId).map((d) => ({ type: 'postgres', name: d.name, reason: 'exists' })),
      ...this.stList(projectId).map((x) => ({ type: 'storage', name: x.name, reason: 'exists' })),
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
    service: ServiceRow | undefined; state: string
  }> {
    const t = this.computeTarget(projectId, serviceId, branchName)
    return this.withOp([this.serviceKey(t.branch, `cp-${t.group}`)], () => this.lifecycleLocked(projectId, verb, t.branch.id, t.group))
  }

  // Branch ID, not a Branch — same reason as deployLocked: a snapshot taken before the chain is one
  // an op ahead has already moved. A stop queued behind a service's FIRST deploy saw a branch with
  // no app record at all and silently did nothing.
  private async lifecycleLocked(
    projectId: string, verb: 'start' | 'stop' | 'suspend', branchId: string, group: string,
  ): Promise<{ service: ServiceRow | undefined; state: string }> {
    const project = this.getProject(projectId)!
    const branch = loadState().branches[branchId]
    if (!branch) throw new Error('branch not found')
    const serviceId = `cp-${group}`
    const ref = this.ref(project, branch)
    const key = this.serviceKey(branch, serviceId)
    const desired = verb === 'start' ? 'running' : verb === 'stop' ? 'stopped' : 'suspended'
    let state = 'none'
    if (branch.apps[group]) {
      const op = this.compute[verb]
      if (!op) throw new Error(`${verb} is not supported by this compute adapter`)
      // WP3 edit point: the intent is written FIRST for a start, so the wake that follows cannot be
      // refused by the very intent it is clearing (`insta compute start` also re-enables auto-wake).
      if (verb === 'start') mutate((s) => { s.branches[branch.id].apps[group].desiredState = desired })
      // The adapter op stays: it unpauses and starts (or stops with the configured grace) exactly as
      // before. Best-effort, platform parity.
      const graceSec = verb === 'stop' ? this.cfg.sleep.stopGraceSec : undefined
      await (verb === 'stop'
        ? this.compute.stop?.(ref, group, { graceSec })
        : op.call(this.compute, ref, group)
      )?.catch(() => { /* best-effort, platform parity */ })
      if (verb === 'start') {
        // ...and then WAIT for readiness through the scheduler (re-entrant: this holds the key),
        // which also clears the sleep mark and stamps activity. A container that is not there any
        // more is not an error for an intent write: the row keeps the intent and reports `none`.
        await this.wake(key, { door: 'api' }).catch((e: unknown) => {
          if (!(e instanceof NoContainerError)) throw e
        })
      } else {
        mutate((s) => { s.branches[branch.id].apps[group].desiredState = desired })
        if (verb === 'stop') this.scheduler.onStopped(key)
        else this.scheduler.onPaused(key)
      }
      state = this.liveState(key)
    }
    this.emit(projectId, branch.name, 'resource', `service.${verb}`, { service: serviceId })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, serviceId))
    return { service, state }
  }

  /** Restart a compute service: re-run the image it ALREADY runs, so the container is recreated
   *  with a freshly assembled env. `docker restart` would replay the env the container was created
   *  with — env reaches a container at `docker run`, exactly as the platform bakes it into machine
   *  config — so a restart that picks up a changed secret has to be a redeploy on both sides.
   *  Refused unless the desired state is 'running', mirroring the platform's refusal. */
  async restart(projectId: string, serviceId: string, branchName?: string): Promise<{
    service: ServiceRow | undefined; state: string
  }> {
    const t = this.computeTarget(projectId, serviceId, branchName)
    return this.withOp([this.serviceKey(t.branch, `cp-${t.group}`)], () => this.restartLocked(projectId, t.branch.id, t.group))
  }

  private async restartLocked(projectId: string, branchId: string, group: string): Promise<{
    service: ServiceRow | undefined; state: string
  }> {
    const branch = loadState().branches[branchId]
    if (!branch) throw new Error('branch not found')
    // Read the recorded image INSIDE the chain. A deploy queued ahead of this one has already
    // replaced it, and re-running a pre-queue snapshot would roll that deploy back — a restart must
    // re-run what the service runs NOW, which is the whole contract.
    const app = branch.apps[group]
    if (!app) throw new Error('this service has no machines yet — deploy an image first, then retry')
    const desired = app.desiredState ?? 'running'
    if (desired !== 'running') throw new Error(`this service is ${desired} — start it with \`insta compute start\`, which also re-enables auto-wake`)
    // deployLocked, not deploy: this already holds the chain and it is not re-entrant.
    await this.deployLocked(projectId, branchId, group, { image: app.image, port: app.port, hostPort: app.hostPort })
    this.emit(projectId, branch.name, 'resource', 'service.restart', { service: `cp-${group}` })
    const service = (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, `cp-${group}`))
    return { service, state: this.liveState(this.serviceKey(branch, `cp-${group}`)) }
  }

  /** A compute service's desired (developer intent) vs. live runtime state. */
  async serviceState(projectId: string, serviceId: string, branchName?: string): Promise<{ desiredState: string; state: string }> {
    const { branch, group } = this.computeTarget(projectId, serviceId, branchName)
    const app = branch.apps[group]
    return {
      desiredState: app?.desiredState ?? 'running',
      state: app ? this.liveState(this.serviceKey(branch, `cp-${group}`)) : 'none',
    }
  }

  /** Set a storage service's bucket access mode (anonymous public-read vs private). */
  async setServiceAccess(projectId: string, serviceId: string, isPublic: boolean, branchName?: string): Promise<ServiceRow | undefined> {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'storage') throw new Error('access control is only supported for storage services')
    const project = this.getProject(projectId)!
    if (!this.storage.setAccess) throw new Error('access control is not supported by this storage adapter')
    await this.storage.setAccess(this.bucketOf(project, branch, sid), branch.network, isPublic)
    mutate((s) => {
      const row = s.branches[branch.id].buckets?.[sid]
      if (row) row.public = isPublic
      // The registration carries the mode a NEW branch provisions with (services add --public).
      const pr = s.projects[projectId]
      pr.storageServices = (pr.storageServices ?? []).map((x) => (x.id === sid ? { ...x, public: isPublic } : x))
      if (sid === 'st-store') s.branches[branch.id].storagePublic = isPublic
    })
    this.emit(projectId, branch.name, 'resource', 'service.setAccess', { service: sid, public: isPublic })
    return (await this.services(projectId, branch.name)).find((x) => x.id === this.qualifiedId(branch, sid))
  }

  // ---- storage objects (platform parity: `insta storage list|get|delete`, console browser) ----

  /** Resolve an object-operation target: a storage service id + the branch's credential env. */
  private objectTarget(projectId: string, serviceId: string, branchName?: string): Branch & { s3: Record<string, string> } {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'storage') throw new Error('object operations are only supported for storage services')
    const project = this.getProject(projectId)!
    return { ...branch, s3: this.bucketHandle(project, branch, sid)?.env ?? {} }
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
    // The branch comes from a qualified sid FIRST, then ?branch, then the default (decision 49):
    // the CLI reads an id off the branch-scoped list and calls this route with no branch at all.
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const svc = this.serviceOf(projectId, sid)
    if (svc.type !== 'compute') throw new Error('lifecycle control is only supported for compute services')
    return { branch, group: svc.name }
  }

  /** WP3 edit point (decision 53): the ONE runtime-state read the routes use, mapped from
   *  `scheduler.stateOf` by contract section 13. Asleep and starting both report `suspended`,
   *  which is what the CLI prints beside a `running` desired state. */
  private liveState(key: ServiceKey): 'running' | 'stopped' | 'suspended' | 'none' {
    switch (this.scheduler.stateOf(key)) {
      case 'running': return 'running'
      case 'paused': case 'asleep': case 'starting': return 'suspended'
      case 'stopped': return 'stopped'
      default: return 'none'
    }
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
    // Per row: the WP3 healthOverlay hook maps one container's docker state (+ sleep bookkeeping).
    const health = (container: string, desired: 'running' | 'stopped' | 'suspended', sleptAt: number | null | undefined, serviceId: string): { status: string; machines: number; failing: number } => {
      if (!states) return { status: 'unknown', machines: 0, failing: 0 }
      return this.healthOverlay(states.get(container), desired, sleptAt, this.serviceKey(branch, serviceId))
    }
    return {
      services: [
        ...this.dbList(projectId).map((d) => ({
          serviceId: d.id,
          ...health(this.pgContainer(project, branch, d.id), 'running', branch.databases?.[d.id]?.sleptAt, d.id),
        })),
        ...this.managedList(projectId).map((m) => ({ serviceId: m.id, ...health(managedContainerName(ref, m.type, m.name), 'running', branch.managed?.[m.id]?.sleptAt, m.id) })),
        ...this.computeGroupNames(projectId).map((g) => {
          const app = branch.apps[g]
          if (!app) return { serviceId: `cp-${g}`, status: 'none', machines: 0, failing: 0 }
          return { serviceId: `cp-${g}`, ...health(appContainerName(ref, g), app.desiredState ?? 'running', app.sleptAt, `cp-${g}`) }
        }),
      ],
    }
  }

  /** Register a compute group as a service (materializes on first deploy --group <name>).
   *  volumeGib optionally attaches a persistent /data volume; it can also attach any time later
   *  via setServiceVolume (platform #185 parity) and be deleted via removeServiceVolume (data
   *  destroyed) — but never detached. */
  addComputeService(
    projectId: string, name: string, volumeGib?: number,
    opts: { alwaysOn?: boolean; port?: number; templateDeploymentId?: string; templateCode?: string } = {},
  ): ServiceRow {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    this.assertServiceName(name)
    const groups = new Set(project.computeGroups ?? [])
    for (const b of this.listBranches(projectId)) for (const g of Object.keys(b.apps)) groups.add(g)
    if (groups.has(name)) throw new Error(`compute service "${name}" already exists`)
    this.assertTypeCap(groups.size, 'compute')
    if (volumeGib !== undefined) {
      if (!Number.isInteger(volumeGib) || volumeGib < 1) throw new Error('volumeGib must be a positive integer (whole Gi)')
      if (volumeGib > VOLUME_CAP_GIB) throw new Error(`volume exceeds the cap (${VOLUME_CAP_GIB}Gi)`)
      if (!this.compute.supportsVolumes) throw new Error('/data volumes are not supported by this compute adapter — use the docker adapter')
    }
    // The registration and every hostname it will mint are reserved in ONE synchronous mutate
    // (decision 51); the container itself arrives on the first deploy --group <name>.
    mutate((st) => {
      for (const b of this.listBranches(projectId)) this.assertHostFree(this.labelFor('compute', name, this.ref(project, b)))
      const pr = st.projects[projectId]
      pr.computeGroups = [...(pr.computeGroups ?? []), name]
      if (volumeGib !== undefined) (pr.computeVolumes ??= {})[name] = { id: randomUUID().slice(0, 8), sizeGib: volumeGib }
      const settings: ServiceSettings = { createdAt: Date.now() }
      if (opts.alwaysOn !== undefined) settings.alwaysOn = opts.alwaysOn
      if (opts.port !== undefined) settings.port = opts.port
      if (opts.templateDeploymentId !== undefined) settings.templateDeploymentId = opts.templateDeploymentId
      if (opts.templateCode !== undefined) settings.templateCode = opts.templateCode
      ;(pr.serviceSettings ??= {})[`cp-${name}`] = settings
    })
    this.emit(projectId, null, 'resource', 'service.added', { type: 'compute', name, ...(volumeGib !== undefined ? { volumeGib } : {}) })
    return {
      id: `cp-${name}`, type: 'compute', name, status: 'ready', volume_gib: volumeGib ?? null,
      always_on: opts.alwaysOn ?? this.cfg.sleep.alwaysOnDefault,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.templateDeploymentId !== undefined ? { template_deployment_id: opts.templateDeploymentId } : {}),
      ...(opts.templateCode !== undefined ? { template_code: opts.templateCode } : {}),
    }
  }

  /** Rename a compute group everywhere it appears: registration, every branch's deployment
   *  (runtime artifact included, via the adapter), and service-bound user secrets. insta-oss
   *  mints no per-service secret names for compute, so there is nothing to re-key. */
  async renameComputeService(projectId: string, oldName: string, newName: string): Promise<ServiceRow | undefined> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newName)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
    const groups = this.computeGroupNames(projectId)
    if (!groups.includes(oldName)) throw new Error('service not found')
    const current = async (): Promise<ServiceRow | undefined> =>
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
  async removeComputeService(projectId: string, name: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const vol = project.computeVolumes?.[name]
    const t = newTeardown()
    for (const b of this.listBranches(projectId)) {
      if (!b.apps[name]) continue
      await count(t, () => docker(['rm', '-f', '-v', `io-${this.ref(project, b)}-app-${name}`]))
      // WP4: the /data bytes are a directory under the data dir; remove it AFTER the container.
      if (vol) await count(t, () => this.data.remove(this.layout().vol(this.ref(project, b), vol.id)))
      mutate((st) => {
        delete st.branches[b.id].apps[name]
        st.branches[b.id].bindings = (st.branches[b.id].bindings ?? []).filter((x) => x.target !== `compute/${name}`)
      })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.computeGroups = (pr.computeGroups ?? []).filter((g) => g !== name)
      if (pr.computeVolumes) delete pr.computeVolumes[name]
      if (pr.serviceSettings) delete pr.serviceSettings[`cp-${name}`]
    })
    this.router.invalidate()
    this.emit(projectId, null, 'resource', 'service.removed', { type: 'compute', name })
    return t
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
    // WP4: an immutable directory key, minted once and stored, so a rename never detaches the data
    // (decision 16). The directory is `md/<ref>/<prefix>-<dataId>` on every branch.
    const entry = { id: managedServiceId(type, name), type, name, createdAt: Date.now(), dataId: randomUUID().slice(0, 8) }
    const provisioned: Array<{ branch: Branch; password: string; container: string; dataDir: string }> = []
    try {
      for (const b of this.listBranches(projectId)) {
        const password = randomBytes(32).toString('base64url')
        const ref = this.ref(project, b)
        const container = managedContainerName(ref, type, name)
        const dataDir = await this.ensureManagedDirs(ref, type, entry.dataId)
        await this.managedDb.provision(
          { container, network: b.network, type, name, password, dataDir },
          { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, entry.id) },
        )
        provisioned.push({ branch: b, password, container, dataDir })
      }
    } catch (e) {
      for (const p of provisioned) await this.managedDb.destroy(p.container).catch(() => {})
      for (const p of provisioned) await this.data.remove(p.dataDir).catch(() => {})                       // WP4
      throw e
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.managedServices = [...(pr.managedServices ?? []), entry]
      for (const p of provisioned) (st.branches[p.branch.id].managed ??= {})[entry.id] = { password: p.password }
    })
    this.scheduler.register(provisioned.map((p) => this.serviceKey(p.branch, entry.id))) // WP3
    this.emit(projectId, null, 'resource', 'service.added', { type, name })
    return this.managedRow(entry)
  }

  /** Remove a managed database: destroy its container on every branch, unregister. The data goes
   *  with it — same irreversibility class as removing a compute service. */
  async removeManagedService(projectId: string, serviceId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const m = this.managedList(projectId).find((x) => x.id === serviceId)
    if (!m) throw new Error('service not found')
    const branches = this.listBranches(projectId)
    const t = newTeardown()
    for (const b of branches) {
      const ref = this.ref(project, b)
      await count(t, () => this.managedDb.destroy(managedContainerName(ref, m.type, m.name)))
      // WP4: the data goes with the container (same irreversibility class as the compute service).
      await count(t, () => this.data.remove(this.layout().md(ref, m.type, m.dataId ?? m.name)))
      mutate((st) => {
        delete st.branches[b.id].managed?.[serviceId]
        st.branches[b.id].bindings = (st.branches[b.id].bindings ?? []).filter((x) => x.source !== `${m.type}/${m.name}`)
      })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.managedServices = (pr.managedServices ?? []).filter((x) => x.id !== serviceId)
    })
    this.scheduler.forget(branches.map((b) => this.serviceKey(b, serviceId))) // WP3
    this.router.invalidate()
    this.emit(projectId, null, 'resource', 'service.removed', { type: m.type, name: m.name })
    return t
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
      const ref = this.ref(project, b)
      await this.managedDb.rename(managedContainerName(ref, m.type, m.name), managedContainerName(ref, m.type, newName))
      this.scheduler.rekey(this.serviceKey(b, serviceId), this.serviceKey(b, newId)) // WP3
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
    service: ServiceRow | undefined; volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean
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
    service: ServiceRow | undefined; volume: null; cap: { volumeGib: number }; removed: true
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
      // WP4: the redeploy above dropped the mount; now the bytes go too.
      await this.data.remove(this.layout().vol(this.ref(project!, b), vol.id)).catch(() => {})
    }
    this.emit(projectId, null, 'resource', 'service.volume', { service: serviceId, sizeGib: null, removed: true })
    const service = (await this.services(projectId)).find((s) => s.id === serviceId)
    return { service, volume: null, cap: { volumeGib: VOLUME_CAP_GIB }, removed: true }
  }

  /** Read-only DB instance view (DbInstanceInfo shape): settings + volume size + the cap. Local
   *  values are honest constants — pooling/scale-to-zero are cloud provider levers with no
   *  docker-postgres analog. Includes the deprecated storage* aliases the platform still mirrors. */
  dbInstance(projectId: string, branchName?: string, group?: string): Record<string, unknown> {
    const t = this.dbTarget(projectId, branchName, group)
    const branch = t.branch
    const gib = branch.dbVolumeGib ?? DB_VOLUME_DEFAULT_GIB
    // WP3 edit point: `scaleToZero`, `idleTimeoutSecs` and the cpu/memory ceiling are real now, and
    // `host`/`port` are the row's LANE address (WP2), which is what a client actually dials.
    const row = branch.databases?.[t.serviceId]
    const lane = this.laneAddress(t.project, branch, t.serviceId)
    const limits = row?.limits
    return {
      id: t.serviceId, name: t.serviceId.replace(/^pg-/, ''), state: branch.status,
      host: lane.host, port: lane.port,
      routeKey: this.labelFor('postgres', t.serviceId.replace(/^pg-/, ''), this.ref(t.project, branch)),
      connectionPooling: false, deletionProtection: false,
      scaleToZero: row?.scaleToZero ?? true,
      idleTimeoutSecs: row?.idleTimeoutSec ?? this.cfg.sleep.idleDbSec,
      ...(limits ? { cpuMilli: limits.cpu * 1000, memoryMib: limits.memoryMb } : { cpuMilli: null, memoryMib: null }),
      volumeSize: `${gib}Gi`, volumeGib: gib,
      storageSize: `${gib}Gi`, storageGiB: gib, // DEPRECATED aliases — dropped when the platform drops them
      cap: { ...DB_CAP },
    }
  }

  /** PATCH database/settings: volumeSize ('10Gi', whole Gi, grow-only) is accepted, persisted,
   *  and echoed — advisory locally, the postgres container's disk is unbounded. `scaleToZero`,
   *  `idleTimeout`, `cpu` and `memory` are REAL here (WP3): they are the instance's own sleep and
   *  ceiling levers, per branch, because the database is a per-branch container. Connection pooling
   *  stays a cloud lever with no local analog: accepted and ignored. */
  async dbSettings(
    projectId: string,
    patch: { volumeSize?: string; storageSize?: string; scaleToZero?: boolean; idleTimeout?: number | string; cpu?: number | string; memory?: number | string },
    branchName?: string, group?: string,
  ): Promise<Record<string, unknown>> {
    const t = this.dbTarget(projectId, branchName, group)
    const { branch } = t
    await this.patchDbScheduling(t, patch)
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
    return this.dbInstance(projectId, branchName, group)
  }

  /** The scheduler half of `PATCH database/settings` (WP3): the sleep lever, the idle window and
   *  the cgroup ceiling of ONE postgres service on ONE branch. Each field is optional and only a
   *  real change writes state or moves a container. */
  private async patchDbScheduling(
    t: { project: Project; branch: Branch; serviceId: string; container: string },
    patch: { scaleToZero?: boolean; idleTimeout?: number | string; cpu?: number | string; memory?: number | string },
  ): Promise<void> {
    const row = t.branch.databases?.[t.serviceId]
    if (!row) return
    const write = (fn: (r: NonNullable<Branch['databases']>[string]) => void): void => {
      mutate((s) => {
        const target = s.branches[t.branch.id].databases?.[t.serviceId]
        if (target) fn(target)
      })
    }
    if (patch.scaleToZero !== undefined) {
      if (typeof patch.scaleToZero !== 'boolean') throw new Error('scaleToZero must be a boolean')
      if (patch.scaleToZero !== (row.scaleToZero ?? true)) {
        write((r) => { r.scaleToZero = patch.scaleToZero })
        this.emit(t.project.id, t.branch.name, 'resource', 'service.alwaysOn', { service: t.serviceId, enabled: !patch.scaleToZero })
      }
    }
    if (patch.idleTimeout !== undefined) {
      const secs = Number(patch.idleTimeout)
      if (!Number.isInteger(secs) || secs < 0) throw new Error('idleTimeout must be a whole number of seconds (0 disables sleep)')
      if (secs !== row.idleTimeoutSec) write((r) => { r.idleTimeoutSec = secs })
    }
    if (patch.cpu !== undefined || patch.memory !== undefined) {
      const current = row.limits
      const cpu = patch.cpu !== undefined ? this.parseCpuQuantity(patch.cpu) : current?.cpu
      const memoryMb = patch.memory !== undefined ? this.parseMemoryQuantity(patch.memory) : current?.memoryMb
      if (memoryMb === undefined) throw new Error('memory is required when setting a cpu ceiling for the first time')
      const limits = this.validateLimits(memoryMb, cpu)
      const key = this.serviceKey(t.branch, t.serviceId)
      await this.withOp([key], async () => {
        try { await this.scheduler.runtimeUpdate(t.container, limits) }
        catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          const err = new Error(`resize failed on the compute provider: ${m} (applied to 0/1 machines; the stored ceiling is unchanged)`)
          Object.assign(err, { status: 502 })
          throw err
        }
        write((r) => { r.limits = limits })
      })
      this.emit(t.project.id, t.branch.name, 'resource', 'service.limits', { service: t.serviceId, ...limits })
    }
  }

  // ---- database management (password / databases / extensions / insight — cloud parity) ----

  /** Extensions the daemon itself depends on — installed by the platform, cannot be disabled
   *  (plpgsql is postgres's own default; pg_stat_statements backs `insta` query-stats). */
  private static REQUIRED_EXTENSIONS = ['plpgsql', 'pg_stat_statements']
  private static DB_NAME_RE = /^[A-Za-z0-9._-]+$/
  private quoteIdent(name: string): string { return `"${name.replace(/"/g, '""')}"` }

  /** The branch's connection URL with the database name swapped. */
  private connStringFor(url: string, database: string): string {
    const u = new URL(url)
    return `${u.protocol}//${u.username}:${u.password}@${u.host}/${database}`
  }

  /** Set or regenerate the postgres user password; re-mints the branch's DATABASE_URL. Deployed
   *  containers keep the old env until their next deploy — same as the cloud. */
  async dbSetPassword(projectId: string, password: string | undefined, branchName?: string, group?: string): Promise<{ connString: string; password: string }> {
    const t = this.dbTarget(projectId, branchName, group)
    const pw = password ?? randomBytes(24).toString('base64url')
    // WP3 (decision 48): management is an explicit operation, so it WAKES a sleeping instance.
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `alter user postgres with password '${pw.replace(/'/g, "''")}'`))
    const u = new URL(t.url)
    const connString = `${u.protocol}//${u.username}:${encodeURIComponent(pw)}@${u.host}${u.pathname}`
    mutate((st) => {
      const row = st.branches[t.branch.id].databases?.[t.serviceId]
      if (row) row.url = connString
      // A legacy branch keeps its deprecated mirror in step until the migration drops it.
      if (t.serviceId === 'pg-db' && st.branches[t.branch.id].dbUrl !== undefined) st.branches[t.branch.id].dbUrl = connString
    })
    this.emit(projectId, t.branch.name, 'resource', 'db.password.set', { generated: !password })
    return { connString, password: pw }
  }

  async dbListDatabases(projectId: string, branchName?: string, group?: string): Promise<{ databases: Array<{ name: string; connString: string }> }> {
    const t = this.dbTarget(projectId, branchName, group)
    const rows = JSON.parse(await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, observe.DB_DATABASES_SQL))) as Array<{ name: string }>
    return { databases: rows.map((r) => ({ name: r.name, connString: this.connStringFor(t.url, r.name) })) }
  }

  async dbCreateDatabase(projectId: string, name: string, branchName?: string, group?: string): Promise<{ name: string; connString: string }> {
    const t = this.dbTarget(projectId, branchName, group)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `create database ${this.quoteIdent(name)}`))
    this.emit(projectId, t.branch.name, 'resource', 'db.database.create', { name })
    return { name, connString: this.connStringFor(t.url, name) }
  }

  async dbDeleteDatabase(projectId: string, name: string, branchName?: string, group?: string): Promise<void> {
    const t = this.dbTarget(projectId, branchName, group)
    if (!Engine.DB_NAME_RE.test(name)) throw new Error('database name must match ^[A-Za-z0-9._-]+$')
    // 'app' is the local substrate's fixed primary (adapters/postgres.ts DB); the URL-derived
    // name covers adapters that mint a different primary.
    const primary = new URL(t.url).pathname.slice(1) || 'app'
    if (name === primary || name === 'app' || name === 'postgres' || name.startsWith('template')) {
      throw new Error(`cannot delete ${name === primary || name === 'app' ? 'the primary database' : 'a system database'} (${name})`)
    }
    // WITH (FORCE): a control plane must not be blocked by an app holding a connection open.
    await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, `drop database ${this.quoteIdent(name)} with (force)`))
    this.emit(projectId, t.branch.name, 'resource', 'db.database.delete', { name })
  }

  /** Installed + available extensions. Local postgres is full-power: `available` is the image's
   *  real pg_available_extensions, not a curated allowlist; the daemon's own two are `required`. */
  async dbExtensions(projectId: string, branchName?: string, group?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    const r = JSON.parse(await this.pgManage(t.branch, t.serviceId, () => this.db.query(t.container, observe.DB_EXTENSIONS_SQL))) as { available: Array<{ name: string }>; enabled: string[] }
    return {
      available: r.available.map((a) => (Engine.REQUIRED_EXTENSIONS.includes(a.name) ? { name: a.name, required: true } : { name: a.name })),
      enabled: r.enabled,
    }
  }

  async dbPatchExtensions(projectId: string, patch: { enable?: string[]; disable?: string[] }, branchName?: string, group?: string): Promise<{ available: Array<{ name: string; required?: boolean }>; enabled: string[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    const container = t.container
    const view = await this.dbExtensions(projectId, t.branch.name, group)
    const known = new Set(view.available.map((a) => a.name))
    for (const name of [...(patch.enable ?? []), ...(patch.disable ?? [])]) {
      if (!known.has(name)) throw new Error(`unknown extension: ${name}`)
    }
    for (const name of patch.disable ?? []) {
      if (Engine.REQUIRED_EXTENSIONS.includes(name)) throw new Error(`extension ${name} is required by the platform and cannot be disabled`)
    }
    await this.pgManage(t.branch, t.serviceId, async () => {
      for (const name of patch.enable ?? []) await this.db.query(container, `create extension if not exists ${this.quoteIdent(name)}`)
      for (const name of patch.disable ?? []) await this.db.query(container, `drop extension if exists ${this.quoteIdent(name)}`)
    })
    this.emit(projectId, t.branch.name, 'resource', 'db.extensions.update', { enable: patch.enable ?? [], disable: patch.disable ?? [] })
    return this.dbExtensions(projectId, t.branch.name, group)
  }

  /** Deep database health (DbInsight shape): size breakdown, per-table stats, vacuum health,
   *  unused indexes — same sections the cloud serves, read straight off the branch container. */
  async dbInsight(projectId: string, branchName?: string, group?: string): Promise<observe.DbInsight> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return observe.toDbInsight(await this.db.query(t.container, observe.DB_INSIGHT_SQL))
  }

  /** Tear down one branch's containers, bucket and network (shared by branch and project delete).
   *  After the containers: data directories (WP4), scheduler keys (WP3), custom domains (WP2). */
  private async teardownBranch(project: Project, b: Branch, t: Teardown): Promise<void> {
    const ref = this.ref(project, b)
    await count(t, () => this.compute.destroy(ref))
    for (const d of this.dbList(project.id)) await count(t, () => this.db.destroy(this.pgContainer(project, b, d.id)))
    for (const x of this.stList(project.id)) await count(t, () => this.storage.destroy(this.bucketOf(project, b, x.id), b.network))
    const managed = this.managedList(project.id)
    for (const m of managed) await count(t, () => this.managedDb.destroy(managedContainerName(ref, m.type, m.name)))
    try { await docker(['network', 'rm', b.network]) } catch { /* gone */ }
    // WP4: the branch's bytes, after every container that held them. A remove failure is counted and
    // never fails the delete (an unreadable directory must not wedge `insta branch delete`).
    for (const root of this.layout().branchRoots(ref)) {
      await count(t, () => this.data.remove(root).catch((e) => {
        console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      }))
    }
    const ids = [...this.dbList(project.id).map((d) => d.id), ...managed.map((m) => m.id), ...Object.keys(b.apps).map((g) => `cp-${g}`)]
    this.scheduler.forget(ids.map((sid) => this.serviceKey(b, sid)))                                          // WP3
    this.releaseDomainsFor(project.id, b.id)                                                                  // WP2
  }

  /** Delete one branch. Answers the cloud's teardown summary (decision 50): how many provider
   *  objects went and how many refused to, counted across containers, buckets and directories. */
  async destroyBranch(projectId: string, branchId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    const b = loadState().branches[branchId]
    if (!project || !b || b.projectId !== projectId) throw new Error('branch not found')
    if (b.isDefault) throw new Error('cannot delete the default branch')
    const t = newTeardown()
    await this.teardownBranch(project, b, t)
    mutate((s) => { delete s.branches[branchId] })
    this.router.invalidate()
    this.emit(projectId, b.name, 'resource', 'branch.deleted', { teardown: t })
    return t
  }

  async destroyProject(projectId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const t = newTeardown()
    for (const b of this.listBranches(projectId)) {
      await this.teardownBranch(project, b, t)
      mutate((s) => { delete s.branches[b.id] })
    }
    mutate((s) => { delete s.projects[projectId] })
    this.router.invalidate()
    return t
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
    // 'db' fans out over the project's postgres services; `group` narrows it to one by NAME, the
    // same `?group=` the database routes take.
    if (component === 'db') {
      return this.dbList(project.id)
        .filter((d) => !group || d.name === group)
        .map((d) => this.pgContainer(project, branch, d.id))
    }
    if (component !== 'compute') {
      return this.managedList(project.id)
        .filter((m) => m.type === component && (!group || m.name === group) && branch.managed?.[m.id])
        .map((m) => managedContainerName(ref, m.type, m.name))
    }
    const groups = group ? [group] : Object.keys(branch.apps).sort()
    return groups.filter((g) => branch.apps[g]).map((g) => appContainerName(ref, g))
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
  async dbMetricsSnapshot(projectId: string, branchName?: string, group?: string): Promise<observe.DbMetricsSnapshot> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return observe.toDbMetrics(await this.db.query(t.container, observe.DB_METRICS_SQL))
  }

  /** Currently running queries (pg_stat_activity, ≤100). */
  async dbActivity(projectId: string, branchName?: string, group?: string): Promise<{ queries: observe.DbActivityRow[] }> {
    const t = this.dbTarget(projectId, branchName, group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    return { queries: observe.toDbActivity(await this.db.query(t.container, observe.DB_ACTIVITY_SQL)) }
  }

  /** Top statements by execution time (pg_stat_statements; preloaded on newly-provisioned branch
   *  databases — older containers report extensionReady:false, exactly like the cloud's
   *  "enabled on demand" path when the extension can't load). */
  async dbQueryStats(projectId: string, branchName: string | undefined, opts: { limit?: number; sort?: observe.QueryStatSort; group?: string } = {}): Promise<observe.DbQueryStats> {
    const t = this.dbTarget(projectId, branchName, opts.group)
    await this.assertPgAwake(t.branch, t.serviceId)                             // WP3: never wakes
    const container = t.container
    try {
      await this.db.query(container, 'create extension if not exists pg_stat_statements')
      const rows = await this.db.query(container, observe.queryStatsSql(opts.limit ?? 20, opts.sort ?? 'total'))
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
      ...this.dbList(projectId).map((d) => ({
        kind: 'postgres', name: d.name as string | null, branchId: b.id,
        ref: { url: this.dbHandle(project, b, d.id)?.url }, status: 'ready',
      })),
      ...this.stList(projectId).map((x) => ({
        kind: 'storage', name: x.name as string | null, branchId: b.id,
        ref: { bucket: this.bucketHandle(project, b, x.id)?.bucket }, status: 'ready',
      })),
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

  // ---------------------------------------------------------------------------------------------
  // Package regions (contract 00 sections 1.3 and 7.1). Every `filled by WPn` hook below is an
  // identity / no-op that returns TODAY's value; the owning package replaces the body inside its
  // own region and never edits the callers above (the 7.2 edit points already go through them).
  // ---------------------------------------------------------------------------------------------

  // ---- region WP1 (identity/config) ----
  // ---- end region WP1 ----

  // ---- region WP2 (router) ----
  /** The FQDN a service answers on: the bounded label (decision 55) plus the run mode's domain. Minted
   *  ONCE and recorded on the row (`apps[g].host`, `databases[id].host`, `managed[id].host`); every
   *  later read takes the row's value, so a rename or a config change never moves a live hostname. */
  hostFor(kind: HostKind, name: string, ref: string): string { return fqdnFor(kind, name, ref, this.cfg.domain) }
  /** The bare label only: what `assertHostFree` compares and what the 63-char bound applies to. */
  labelFor(kind: HostKind, name: string, ref: string): string { return labelFor(kind, name, ref) }
  /** Operator-supplied custom-domain hostnames only (400); minted labels are bounded, never rejected. */
  assertHostLabel(hostname: string): void { assertHostLabel(hostname) }

  /** Lane ports a bind probe refused. The router reports them here when a listener could not open, so
   *  the next allocation skips the port instead of handing it out again. `allocLanes` runs inside one
   *  synchronous `mutate` (decision 51) and a bind probe cannot be synchronous, hence this ledger
   *  rather than a probe at allocation time. */
  private readonly laneBusy = new Set<number>()
  markLaneBusy(port: number): void { this.laneBusy.add(port) }

  /** Which of a branch's services need a host listen port: local mode every database (postgres and
   *  managed), server mode MySQL only (redis and mongo share the SNI lanes, decision 38). */
  private laneServiceIds(project: Project, serviceIds: string[]): string[] {
    const managed = new Map(this.managedList(project.id).map((m) => [m.id, m.type]))
    return serviceIds.filter((id) => {
      const type = managed.get(id)
      if (this.cfg.mode === 'local') return id.startsWith('pg-') || type !== undefined
      return type === 'mysql'
    })
  }

  private nextLanePort(taken: Set<number>): number {
    const [lo, hi] = this.cfg.lanes.portRange
    for (let p = lo; p <= hi; p++) if (!taken.has(p) && !this.laneBusy.has(p)) return p
    throw new Error(`no free lane port left in ${lo}-${hi} (INSTA_OSS_LANE_PORT_RANGE)`)
  }

  private takenLanePorts(s: State): Set<number> {
    const taken = new Set<number>()
    for (const b of Object.values(s.branches)) for (const p of Object.values(b.lanes ?? {})) taken.add(p)
    for (const p of Object.keys(s.laneReservations ?? {})) taken.add(Number(p))
    return taken
  }

  /** The lowest free port in the configured range (contract 7.1). Used by the router when something
   *  else already holds a service's lane port. */
  allocLanePort(): number { return this.nextLanePort(this.takenLanePorts(loadState())) }
  /** The host listen port of one database service on one branch. `provisionBranch` reserves the lanes
   *  a branch needs at create time; a service ADDED later (a redis on an existing branch) has none, so
   *  the first read allocates one and records it, which is also what makes the router open its
   *  listener on the next invalidate. Idempotent and once per service. */
  private laneFor(branch: Branch, serviceId: string, fallback: number): number {
    const known = branch.lanes?.[serviceId]
    if (known !== undefined) return known
    if (!this.laneNeeded(branch, serviceId)) return fallback
    const port = this.allocLanePort()
    mutate((s) => {
      const row = s.branches[branch.id]
      if (!row) return
      row.lanes = { ...(row.lanes ?? {}), [serviceId]: port }
      delete s.laneReservations?.[String(port)]
    })
    branch.lanes = { ...(branch.lanes ?? {}), [serviceId]: port }
    this.router.invalidate()
    return port
  }

  /** Local mode gives every database service a port; server mode only MySQL (decision 38). */
  private laneNeeded(branch: Branch, serviceId: string): boolean {
    if (!branch.id || !loadState().branches[branch.id]) return false
    if (this.cfg.mode === 'local') return true
    return serviceId.startsWith(MANAGED_DB.mysql.idPrefix + '-')
  }

  /** Reserve every lane port a new branch needs in ONE synchronous mutate before provisioning awaits,
   *  so two concurrent `branch create` calls on two projects can never share a port (decision 51). */
  allocLanes(project: Project, branchId: string, serviceIds: string[]): Record<string, number> {
    const ids = this.laneServiceIds(project, serviceIds)
    if (!ids.length) return {}
    return mutate((s) => {
      const taken = this.takenLanePorts(s)
      const out: Record<string, number> = {}
      s.laneReservations = s.laneReservations ?? {}
      for (const id of ids) {
        const port = this.nextLanePort(taken)
        taken.add(port)
        out[id] = port
        s.laneReservations[String(port)] = branchId
      }
      return out
    })
  }

  /** Compensation path: drop the reservations a failed provision took. On success the branch row's
   *  `lanes` supersedes them and `provisionBranch` clears them in the same mutate that writes the row. */
  releaseLanes(branchId: string): void {
    mutate((s) => {
      for (const [port, owner] of Object.entries(s.laneReservations ?? {})) {
        if (owner === branchId) delete s.laneReservations![port]
      }
    })
  }

  /** 409 when a label is reserved or already minted. Runs inside the reservation mutate, under the
   *  engine-wide provision chain, so check-then-act cannot interleave (decision 51). */
  assertHostFree(label: string): void {
    const host = `${label}.${this.cfg.domain}`
    if (RESERVED_LABELS.has(label)) throw new Error(`hostname ${host} is reserved by the daemon`)
    if (buildTable(loadState(), this.cfg, () => { /* quiet: this is a check, not a rebuild */ }).hosts().has(host)) {
      throw new Error(`hostname ${host} already exists on this daemon`)
    }
  }

  /** Where a client dials one database service. Server mode: the minted hostname on the shared lane
   *  with TLS (SNI routes it); MySQL keeps a plaintext per-service port. Local mode: loopback plus the
   *  branch's lane port. */
  laneAddress(project: Project, branch: Branch, serviceId: string): { host: string; port: number; tls: boolean } {
    const ref = this.ref(project, branch)
    const server = this.cfg.mode === 'server'
    if (serviceId.startsWith('pg-')) {
      const host = branch.databases?.[serviceId]?.host ?? this.hostFor('postgres', serviceId.slice(3), ref)
      return server ? { host, port: this.cfg.lanes.pgPort, tls: true } : { host: '127.0.0.1', port: this.laneFor(branch, serviceId, 5432), tls: false }
    }
    const m = this.managedList(project.id).find((x) => x.id === serviceId)
    if (m) {
      const host = branch.managed?.[serviceId]?.host ?? this.hostFor(m.type, m.name, ref)
      if (!server) return { host: '127.0.0.1', port: this.laneFor(branch, serviceId, MANAGED_DB[m.type].port), tls: false }
      if (m.type === 'redis') return { host, port: this.cfg.lanes.redisPort, tls: true }
      if (m.type === 'mongodb') return { host, port: this.cfg.lanes.mongoPort, tls: true }
      return { host, port: this.laneFor(branch, serviceId, MANAGED_DB.mysql.port), tls: false }
    }
    const group = serviceId.replace(/^cp-/, '')
    const host = branch.apps[group]?.host ?? this.hostFor('compute', group, ref)
    return server ? { host, port: 443, tls: true } : { host, port: this.cfg.port, tls: false }
  }

  /** The app's URL, deterministic before the container exists (the deploy records it on the row). */
  serviceUrl(project: Project, branch: Branch, group: string): string {
    const host = branch.apps[group]?.host ?? this.hostFor('compute', group, this.ref(project, branch))
    return this.cfg.mode === 'server' ? `https://${host}` : `http://${host}:${this.cfg.port}`
  }

  /** The bare hostname `deployLocked` records on `apps[g].host`: minted once, then read back. */
  mintedHost(project: Project, branch: Branch, group: string): string | undefined {
    return branch.apps[group]?.host ?? this.hostFor('compute', group, this.ref(project, branch))
  }

  /** Local mode: a container cannot reach the host's loopback by that name, so every 127.0.0.1 in a
   *  URL-shaped or `*_HOST` value becomes `host.docker.internal` (pinned to host-gateway by the deploy
   *  aliases). Server mode: the same string works on the host and inside a container. */
  containerize(env: Record<string, string>): Record<string, string> {
    if (this.cfg.mode === 'server') return env
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      const urlish = /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
      out[k] = urlish || k.endsWith('_HOST') ? v.replace(/127\.0\.0\.1/g, 'host.docker.internal') : v
    }
    return out
  }

  /** Every name a container on this branch must resolve to the box itself (decision 5): the branch's
   *  minted hostnames, the daemon and object-store names its env points at, its bucket vhosts, its
   *  custom domains, and `host.docker.internal`. Public DNS cannot be trusted to send these to the box
   *  (sslip.io, NAT, private addresses), so each becomes `--add-host <name>:host-gateway`. */
  hostAliasesFor(project: Project, branch: Branch): string[] {
    const ref = this.ref(project, branch)
    const out = new Set<string>()
    for (const [g, app] of Object.entries(branch.apps ?? {})) out.add(app.host ?? this.hostFor('compute', g, ref))
    for (const [id, db] of Object.entries(databasesOf(branch, ref))) out.add(db.host ?? this.hostFor('postgres', id.replace(/^pg-/, ''), ref))
    for (const m of this.managedList(project.id)) {
      const row = branch.managed?.[m.id]
      if (row) out.add(row.host ?? this.hostFor(m.type, m.name, ref))
    }
    if (this.cfg.mode === 'server') {
      out.add(`api.${this.cfg.domain}`)
      out.add(`s3.${this.cfg.domain}`)
      for (const bucket of bucketsOf(branch)) out.add(`${bucket}.s3.${this.cfg.domain}`)
      for (const cd of Object.values(loadState().customDomains ?? {})) if (cd.branchId === branch.id) out.add(cd.hostname)
    }
    out.add('host.docker.internal')
    return [...out]
  }

  /** Local mode publishes the app on a loopback host port (macOS cannot route to container IPs);
   *  server mode publishes nothing and the router dials the container. A redeploy keeps the port the
   *  row already has; a legacy row without `host` still carries it in its `http://localhost:<port>` url. */
  localHostPort(branch: Branch, group: string, opts: { hostPort?: number; port: number }): number | undefined {
    if (this.cfg.mode === 'server') return undefined
    const prior = branch.apps[group]
    const fromLegacyUrl = prior && !prior.host && prior.url ? Number(new URL(prior.url).port) || undefined : undefined
    return opts.hostPort ?? prior?.hostPort ?? fromLegacyUrl ?? opts.port
  }

  /** The services() row's network columns: `domain` is the bare hostname, `endpoint` is `host[:port]`
   *  (a script may read it, so it stays a host and port, never a URL; decision 40). */
  rowNetwork(project: Project, branch: Branch | undefined, row: { id: string; type: string; name: string }): { domain?: string; endpoint?: string } {
    if (!branch) return {}
    const ref = this.ref(project, branch)
    if (row.type === 'compute') {
      const app = branch.apps[row.name]
      if (!app) return {}
      const host = app.host ?? this.hostFor('compute', row.name, ref)
      return { domain: host, endpoint: this.cfg.mode === 'server' ? host : `${host}:${this.cfg.port}` }
    }
    if (row.type === 'postgres' || isManagedDbType(row.type)) {
      const minted = row.type === 'postgres'
        ? (branch.databases?.[row.id]?.host ?? this.hostFor('postgres', row.name, ref))
        : (branch.managed?.[row.id]?.host ?? this.hostFor(row.type as ManagedDbType, row.name, ref))
      const lane = this.laneAddress(project, branch, row.id)
      return { domain: minted, endpoint: `${lane.host}:${lane.port}` }
    }
    if (row.type === 'storage') {
      const bucket = this.bucketOf(project, branch, row.id)
      if (this.cfg.mode === 'server') return { domain: `${bucket}.s3.${this.cfg.domain}`, endpoint: `s3.${this.cfg.domain}/${bucket}` }
      return { endpoint: `${this.s3Host(project, branch, row.id) ?? 'storage'}/${bucket}` }
    }
    return {}
  }

  // ---- custom domains (the four hidden cloud routes, decision 25) ------------------------------

  /** The compute group a domain call means: the body's, or the branch's sole group. */
  private domainTarget(projectId: string, opts: { branch?: string; group?: string }): { project: Project; branch: Branch; group: string } {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const branch = opts.branch ? this.getBranchByName(projectId, opts.branch) : this.listBranches(projectId).find((b) => b.isDefault)
    if (!branch) throw new DomainError(404, `branch not found: ${opts.branch ?? 'default'}`)
    const groups = Object.keys(branch.apps ?? {})
    const group = opts.group ?? (groups.length === 1 ? groups[0] : undefined)
    if (!group) throw new DomainError(400, groups.length ? `group required: ${groups.join(', ')}` : 'group required')
    return { project, branch, group }
  }

  private domainCertOk(hostname: string): boolean {
    if (this.cfg.mode !== 'server' || !this.cfg.tls.certDir) return true
    return findCertFiles(this.cfg.tls.certDir, hostname) !== null
  }

  private async domainEnvelope(project: Project, branch: Branch, group: string, hostname: string): Promise<ComputeDomainResult> {
    const dns = await checkDns(hostname, this.cfg)
    return domainResult({
      hostname, flyApp: appContainerName(this.ref(project, branch), group), service: group,
      dns, certOk: this.domainCertOk(hostname),
    })
  }

  /** Attach a hostname to one compute group on one branch (idempotent on the same target). */
  async setComputeDomain(projectId: string, opts: { hostname?: unknown; branch?: string; group?: string }): Promise<ComputeDomainResult> {
    const { project, branch, group } = this.domainTarget(projectId, opts)
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    if (!branch.apps?.[group]) throw new DomainError(404, `no compute deployed for group ${group} on branch ${branch.name}`)
    const existing = loadState().customDomains?.[hostname]
    if (existing && (existing.branchId !== branch.id || existing.group !== group)) {
      throw new DomainError(409, `${hostname} is already attached to ${existing.group}; remove it there first`)
    }
    if (!existing) {
      mutate((s) => {
        s.customDomains = s.customDomains ?? {}
        s.customDomains[hostname] = { hostname, projectId, branchId: branch.id, group, createdAt: Date.now() }
      })
      this.router.invalidate()
      this.emit(projectId, branch.name, 'resource', 'compute.domain.set', { hostname, group })
    }
    return await this.domainEnvelope(project, branch, group, hostname)
  }

  /** The check-domain answer, bound or not. */
  async computeDomainStatus(projectId: string, opts: { hostname?: unknown; branch?: string; group?: string }): Promise<ComputeDomainResult> {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    const entry = loadState().customDomains?.[hostname]
    if (!entry || entry.projectId !== projectId) {
      const { branch, group } = this.domainTarget(projectId, opts)
      return notAdded(hostname, appContainerName(this.ref(project, branch), group), group)
    }
    const branch = loadState().branches[entry.branchId]
    if (!branch) return notAdded(hostname, '', entry.group)
    return await this.domainEnvelope(project, branch, entry.group, hostname)
  }

  /** Every domain of a project, optionally narrowed to one branch or group. */
  async listComputeDomains(projectId: string, opts: { branch?: string; group?: string } = {}): Promise<ComputeDomainResult[]> {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const s = loadState()
    const branchId = opts.branch ? this.getBranchByName(projectId, opts.branch)?.id : undefined
    const rows = Object.values(s.customDomains ?? {}).filter((cd) =>
      cd.projectId === projectId && (!branchId || cd.branchId === branchId) && (!opts.group || cd.group === opts.group))
    return await Promise.all(rows.map(async (cd) => {
      const branch = s.branches[cd.branchId]
      if (!branch) return notAdded(cd.hostname, '', cd.group)
      return await this.domainEnvelope(project, branch, cd.group, cd.hostname)
    }))
  }

  /** Detach a hostname. 404 when it was never attached to this project. */
  removeComputeDomain(projectId: string, opts: { hostname?: unknown }): { hostname: string; flyApp: string; service: string; region: string } {
    const project = this.getProject(projectId)
    if (!project) throw new DomainError(404, 'project not found')
    const hostname = normalizeHostname(opts.hostname, this.cfg)
    const entry = loadState().customDomains?.[hostname]
    if (!entry || entry.projectId !== projectId) throw new DomainError(404, `domain not found: ${hostname}`)
    const branch = loadState().branches[entry.branchId]
    mutate((s) => { delete s.customDomains?.[hostname] })
    this.router.invalidate()
    this.emit(projectId, branch?.name ?? null, 'resource', 'compute.domain.remove', { hostname, group: entry.group })
    return {
      hostname,
      flyApp: branch ? appContainerName(this.ref(project, branch), entry.group) : '',
      service: entry.group,
      region: 'local',
    }
  }

  /** Called from teardown paths so a deleted branch, project or compute group takes its domains with
   *  it; a rename moves them to the new group. */
  releaseDomainsFor(projectId: string, branchId?: string, group?: string, moveTo?: string): void {
    let changed = false
    mutate((s) => {
      for (const [h, cd] of Object.entries(s.customDomains ?? {})) {
        if (cd.projectId !== projectId) continue
        if (branchId && cd.branchId !== branchId) continue
        if (group && cd.group !== group) continue
        changed = true
        if (moveTo) s.customDomains[h] = { ...cd, group: moveTo }
        else delete s.customDomains[h]
      }
    })
    if (changed) this.router.invalidate()
  }

  /** The ask endpoint's answer: every hostname this daemon serves (service names, api/console, the
   *  object store and its existing bucket vhosts, attached custom domains). */
  ownsHostname(host: string): boolean {
    const h = hostOnly(host)
    if (!h) return false
    return buildTable(loadState(), this.cfg, () => { /* quiet */ }).hosts().has(h)
  }
  // ---- end region WP2 ----

  // ---- region WP3 (scheduler) ----
  /** The ONE address cache (decision 57): `main.ts` hands the same instance to the router, and the
   *  scheduler's `forget` after a sleep or a wake is what keeps the router from dialling a
   *  container that has gone away. */
  readonly upstream: UpstreamLike
  /** The scheduler: sleep, wake, eviction, and THE per-key operation lock. Unstarted here. */
  readonly scheduler: Scheduler
  /** `${branchId}:${serviceId}`, contract section 4 ServiceKey. */
  serviceKey(branch: Branch, serviceId: string): ServiceKey { return `${branch.id}:${serviceId}` }

  /** THE per-key operation lock (decision 52). Every container-mutating path goes through it:
   *  deploy, restart, lifecycle, branch create, teardown, service add/remove/rename, volume ops,
   *  limits, and the scheduler's own wake. Re-entrant inside the acquiring async context, so a
   *  nested `wake` (lifecycle start, a fork waking its source) takes no second acquisition. */
  withOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T> { return this.scheduler.withOp(keys, fn) }

  /** Start a sleeping service and wait until it accepts connections. `traffic` refuses a service
   *  the developer stopped; `api` and `deploy` are explicit and never refused. */
  wake(key: ServiceKey, opts: { door: 'traffic' | 'api' | 'deploy' }): Promise<void> { return this.scheduler.wake(key, opts) }
  /** Put one service to sleep now (the sweep's own path; also `sleepNewBranch`). */
  sleep(key: ServiceKey, reason: 'idle' | 'memory' | 'branch-create'): Promise<boolean> { return this.scheduler.sleep(key, reason) }
  /** A request or a connection read: the only thing that resets the idle clock. */
  touch(key: ServiceKey): void { this.scheduler.touch(key) }
  stateOf(key: ServiceKey): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none' { return this.scheduler.stateOf(key) }
  /** In-flight request/splice bookkeeping the router drives; a held key is never evicted. */
  holds(key: ServiceKey): number { return this.scheduler.holds(key) }
  beginHold(key: ServiceKey): void { this.scheduler.beginHold(key) }
  endHold(key: ServiceKey): void { this.scheduler.endHold(key) }

  /** A clone of a service that is not always-on is created and never started (asleep from birth). */
  startAsleepFor(project: Project, target: Branch, group: string): boolean {
    return !this.effectiveAlwaysOn(project, target, `cp-${group}`)
  }

  /** Whether a service opts out of sleep. Compute and managed databases carry the per-service
   *  setting (else `INSTA_OSS_ALWAYS_ON_DEFAULT`); postgres carries the inverse of its own
   *  per-branch `scaleToZero`, which is what `PATCH database/settings` writes. */
  effectiveAlwaysOn(project: Project, branch: Branch, serviceId: string): boolean {
    if (serviceId.startsWith('pg-')) return !(branch.databases?.[serviceId]?.scaleToZero ?? true)
    return project.serviceSettings?.[serviceId]?.alwaysOn ?? this.cfg.sleep.alwaysOnDefault
  }

  /** Bookkeeping after a deploy replaced the container: running, asleep from birth, or honouring a
   *  standing stop. */
  afterDeploy(key: ServiceKey, o: { started: boolean; startAsleep?: boolean }): void {
    if (o.started) this.scheduler.onUp(key)
    else if (o.startAsleep) this.scheduler.onAsleep(key, 'branch-create')
    else this.scheduler.onStopped(key)
  }

  /** A clone's databases sleep until first use: they were provisioned and readied, and nothing has
   *  asked them for anything yet. Always-on services stay up. */
  async sleepNewBranch(project: Project, branch: Branch): Promise<void> {
    for (const sid of this.branchServiceIds(project)) {
      if (this.effectiveAlwaysOn(project, branch, sid)) continue
      await this.sleep(this.serviceKey(branch, sid), 'branch-create').catch(() => false)
    }
  }

  /** The services() `runtime` column, contract section 13's view mapping. A compute group that was
   *  registered and never deployed has no container at all: `none`. */
  rowRuntime(key: ServiceKey): string | undefined {
    const serviceId = key.slice(key.indexOf(':') + 1)
    if (!this.scheduler.targetOf(key)) return serviceId.startsWith('cp-') ? 'none' : undefined
    switch (this.scheduler.stateOf(key)) {
      case 'running': return 'online'
      case 'asleep': case 'starting': return 'asleep'
      case 'paused': return 'suspended'
      case 'stopped': return 'stopped'
      default: return 'none'
    }
  }

  /** One runtime-health row (contract section 13): `standby` for asleep or suspended, `starting`
   *  while a wake is in flight, and `crashed` ONLY for a container that exited with no sleep mark
   *  against a running intent. `sleptAt` is what separates standby from crashed after a restart. */
  healthOverlay(dockerState: string | undefined, desired: string, sleptAt: number | null | undefined, key: ServiceKey): { status: string; machines: number; failing: number } {
    if (!dockerState) return { status: 'none', machines: 0, failing: 0 }
    const live = this.scheduler.stateOf(key)
    const status = live === 'starting' || dockerState === 'restarting' ? 'starting'
      : dockerState === 'running' ? 'healthy'
        : dockerState === 'paused' ? 'standby'
          : sleptAt !== null && sleptAt !== undefined ? 'standby'
            : dockerState === 'created' ? 'starting'
              : desired === 'running' ? 'crashed' : 'standby'
    return { status, machines: 1, failing: status === 'crashed' ? 1 : 0 }
  }

  /** The cgroup ceiling recorded for a service: project-level for compute and managed databases,
   *  per branch for postgres (its own `PATCH database/settings` writes it). */
  limitsFor(project: Project, serviceId: string, branch?: Branch): ServiceLimits | undefined {
    if (serviceId.startsWith('pg-')) return branch?.databases?.[serviceId]?.limits
    return project.serviceSettings?.[serviceId]?.limits
  }

  // ---- targets: state.json projected for the scheduler -------------------------------------------

  /** Every schedulable service on every branch. Memoized on the state revision, because `stateOf`
   *  runs on the router's request path and `loadState()` clones (decision 54); `markSlept` patches
   *  the cached row in place, since a sleep mark is an audit-class write that bumps no revision. */
  private targetsCache: { rev: number; list: ServiceTarget[] } | undefined
  serviceTargets(): ServiceTarget[] {
    const rev = stateRev()
    if (this.targetsCache?.rev === rev) return this.targetsCache.list
    const s = loadState()
    const list: ServiceTarget[] = []
    for (const b of Object.values(s.branches)) {
      const project = s.projects[b.projectId]
      if (!project) continue
      const ref = this.ref(project, b)
      const common = { projectId: project.id, branchId: b.id, network: b.network }
      for (const d of project.dbServices ?? []) {
        const row = b.databases?.[d.id]
        if (!row) continue
        list.push({
          ...common, key: this.serviceKey(b, d.id), kind: 'postgres', serviceId: d.id,
          container: row.container, port: 5432,
          alwaysOn: this.effectiveAlwaysOn(project, b, d.id),
          desiredState: 'running',                                  // a database has no stop intent
          idleSec: row.idleTimeoutSec ?? this.cfg.sleep.idleDbSec,
          limits: row.limits, sleptAt: row.sleptAt ?? null,
          createdAt: d.createdAt ?? b.createdAt,
        })
      }
      for (const m of project.managedServices ?? []) {
        if (!b.managed?.[m.id]) continue
        list.push({
          ...common, key: this.serviceKey(b, m.id), kind: 'managed', serviceId: m.id,
          container: managedContainerName(ref, m.type, m.name), port: MANAGED_DB[m.type].port,
          alwaysOn: this.effectiveAlwaysOn(project, b, m.id),
          desiredState: 'running',
          idleSec: this.cfg.sleep.idleDbSec,
          limits: this.limitsFor(project, m.id), managedType: m.type,
          sleptAt: b.managed[m.id].sleptAt ?? null,
          createdAt: m.createdAt ?? b.createdAt,
        })
      }
      // Compute groups only once they are deployed: a registered group has no container to schedule.
      for (const [group, app] of Object.entries(b.apps)) {
        const serviceId = `cp-${group}`
        list.push({
          ...common, key: this.serviceKey(b, serviceId), kind: 'compute', serviceId,
          container: appContainerName(ref, group), port: app.port,
          alwaysOn: this.effectiveAlwaysOn(project, b, serviceId),
          desiredState: app.desiredState ?? 'running',
          idleSec: this.cfg.sleep.idleComputeSec,
          limits: this.limitsFor(project, serviceId),
          sleptAt: app.sleptAt ?? null,
          // The ROW's creation time, so a daemon restart does not hand every service a fresh create
          // grace on top of its idle window (decision 10).
          createdAt: project.serviceSettings?.[serviceId]?.createdAt ?? app.updatedAt ?? b.createdAt,
        })
      }
    }
    this.targetsCache = { rev, list }
    return list
  }

  targetOf(key: ServiceKey): ServiceTarget | undefined { return this.scheduler.targetOf(key) }

  /** The sleep mark on the service's own row: audit-class, so it never forces a router table
   *  rebuild (decision 54). The memoized projection is patched in the same breath. */
  private markSlept(key: ServiceKey, at: number | null): void {
    const branchId = key.slice(0, key.indexOf(':'))
    const serviceId = key.slice(key.indexOf(':') + 1)
    mutate((s) => {
      const b = s.branches[branchId]
      if (!b) return
      if (serviceId.startsWith('cp-')) {
        const app = b.apps[serviceId.slice(3)]
        if (app) app.sleptAt = at
      } else if (serviceId.startsWith('pg-')) {
        const row = b.databases?.[serviceId]
        if (row) row.sleptAt = at
      } else {
        const row = b.managed?.[serviceId]
        if (row) row.sleptAt = at
      }
    }, { audit: true })
    const cached = this.targetsCache?.list.find((t) => t.key === key)
    if (cached) cached.sleptAt = at
  }

  /** One scheduler event onto the project's timeline (decision 39): the payload carries the BARE
   *  service id and the branch name, never the branch-qualified key. */
  private emitForKey(key: ServiceKey, kind: string, payload: Record<string, unknown>): void {
    const b = loadState().branches[key.slice(0, key.indexOf(':'))]
    if (!b) return
    this.emit(b.projectId, b.name, 'resource', kind, { ...payload, branch: b.name })
  }

  // ---- always-on and limits (the cloud's two service knobs) --------------------------------------

  /** `PUT /projects/:id/services/:sid/always-on`. No container action: the flag only takes the
   *  service out of the sweep (and, once off, lets the next idle window stop it). */
  async setAlwaysOn(projectId: string, serviceId: string, enabled: boolean): Promise<{ service: ServiceRow | undefined }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('alwaysOn is only supported for compute and managed database services')
    }
    mutate((s) => {
      const p = s.projects[projectId]
      p.serviceSettings ??= {}
      p.serviceSettings[serviceId] = { ...p.serviceSettings[serviceId], alwaysOn: enabled }
    })
    this.emit(projectId, null, 'resource', 'service.alwaysOn', { service: serviceId, enabled })
    return { service: (await this.services(projectId)).find((x) => x.id === serviceId) }
  }

  /** The cloud's shared-cpu ladder (specs.ts): 256 to 2048 MB of memory per vCPU. */
  private static CPU_LADDER = [1, 2, 4, 6, 8] as const
  private static LIMITS_CAP = { cpu: 8, memoryMb: 8192, volumeGib: VOLUME_CAP_GIB }

  /** Validate a requested ceiling against the grid, with the cloud's own wording (specs.ts:131-141,
   *  the dash spelled `to`). An unset cpu is derived: the smallest ladder size that can carry the
   *  memory. */
  private validateLimits(memoryMb: number, cpu?: number): ServiceLimits {
    if (!Number.isInteger(memoryMb)) throw new Error('memoryMb must be an integer number of MB')
    const derived = cpu ?? Engine.CPU_LADDER.find((c) => memoryMb <= c * 2048)
    if (derived === undefined) throw new Error(`no vCPU size can carry ${memoryMb} MB of memory`)
    if (!(Engine.CPU_LADDER as readonly number[]).includes(derived)) {
      throw new Error(`cpu must be one of ${Engine.CPU_LADDER.join(', ')} vCPU`)
    }
    if (memoryMb % 256 !== 0) throw new Error('memoryMb must be a multiple of 256')
    const min = 256 * derived
    const max = 2048 * derived
    if (memoryMb < min || memoryMb > max) {
      throw new Error(`${derived} vCPU supports ${min} to ${max} MB of memory`)
    }
    if (derived > Engine.LIMITS_CAP.cpu || memoryMb > Engine.LIMITS_CAP.memoryMb) {
      throw new Error(`limits exceed this plan's ceiling (${Engine.LIMITS_CAP.cpu} vCPU / ${Engine.LIMITS_CAP.memoryMb} MB)`)
    }
    return { cpu: derived, memoryMb }
  }

  /** What a service runs under when nothing was set: the effective host ceiling, snapped to the
   *  grid (decision 15). */
  private hostCeiling(): ServiceLimits {
    const cpu = [...Engine.CPU_LADDER].reverse().find((c) => c <= Math.min(Engine.LIMITS_CAP.cpu, cpus().length)) ?? 1
    const snapped = Math.floor(totalmem() / (256 * 1024 * 1024)) * 256
    const memoryMb = Math.max(256 * cpu, Math.min(Engine.LIMITS_CAP.memoryMb, 2048 * cpu, snapped))
    return { cpu, memoryMb }
  }

  /** `GET /projects/:id/services/:sid/limits`. */
  serviceLimits(projectId: string, serviceId: string): {
    limits: ServiceLimits; cap: { cpu: number; memoryMb: number; volumeGib: number }; volume?: { sizeGib: number; mountPath: string }
  } {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('limits are only supported for compute and managed database services')
    }
    const vol = svc.type === 'compute' ? project.computeVolumes?.[svc.name] : undefined
    return {
      limits: this.limitsFor(project, serviceId) ?? this.hostCeiling(),
      cap: { ...Engine.LIMITS_CAP },
      ...(vol ? { volume: { sizeGib: vol.sizeGib, mountPath: VOLUME_MOUNT_PATH } } : {}),
    }
  }

  /** `PUT /projects/:id/services/:sid/limits`: validate, apply to every branch container of the
   *  service (`docker update` is legal on a created or exited container too), then persist. A
   *  partial apply is the cloud's 502 and leaves the STORED ceiling alone, so a retry is safe. */
  async setServiceLimits(projectId: string, serviceId: string, patch: { memoryMb: number; cpu?: number }): Promise<{
    service: ServiceRow | undefined; limits: ServiceLimits; cap: { cpu: number; memoryMb: number; volumeGib: number }; changed: boolean
  }> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const svc = this.serviceOf(projectId, serviceId)
    if (svc.type !== 'compute' && !isManagedDbType(svc.type)) {
      throw new Error('limits are only supported for compute and managed database services')
    }
    const limits = this.validateLimits(patch.memoryMb, patch.cpu)
    const current = this.limitsFor(project, serviceId)
    const changed = current?.cpu !== limits.cpu || current?.memoryMb !== limits.memoryMb
    const branches = this.listBranches(projectId)
    const keys = branches.map((b) => this.serviceKey(b, serviceId))
    await this.withOp(keys, async () => {
      const containers = branches
        .map((b) => this.scheduler.targetOf(this.serviceKey(b, serviceId))?.container)
        .filter((c): c is string => c !== undefined)
      let applied = 0
      const failures: string[] = []
      for (const container of containers) {
        try { await this.scheduler.runtimeUpdate(container, limits); applied++ }
        catch (e) { failures.push(e instanceof Error ? e.message : String(e)) }
      }
      if (failures.length) {
        const err = new Error(`resize failed on the compute provider: ${failures[0]} (applied to ${applied}/${containers.length} machines; the stored ceiling is unchanged)`)
        Object.assign(err, { status: 502 })
        throw err
      }
      if (changed) {
        mutate((s) => {
          const p = s.projects[projectId]
          p.serviceSettings ??= {}
          p.serviceSettings[serviceId] = { ...p.serviceSettings[serviceId], limits }
        })
      }
    })
    if (changed) this.emit(projectId, null, 'resource', 'service.limits', { service: serviceId, ...limits })
    return { service: (await this.services(projectId)).find((x) => x.id === serviceId), limits, cap: { ...Engine.LIMITS_CAP }, changed }
  }

  /** A kubernetes-style cpu quantity (`2`, `2500m`) rounded UP to the ladder. */
  parseCpuQuantity(raw: string | number): number {
    const text = String(raw).trim()
    const milli = /m$/.test(text) ? Number(text.slice(0, -1)) : Number(text) * 1000
    if (!Number.isFinite(milli) || milli <= 0) throw new Error(`invalid cpu quantity: ${raw} (try '2' or '2000m')`)
    const wanted = milli / 1000
    const snapped = Engine.CPU_LADDER.find((c) => c >= wanted)
    if (snapped === undefined) throw new Error(`cpu must be one of ${Engine.CPU_LADDER.join(', ')} vCPU`)
    return snapped
  }

  /** A kubernetes-style memory quantity (`4Gi`, `2048Mi`, `512M`, bytes) in whole MB. */
  parseMemoryQuantity(raw: string | number): number {
    const text = String(raw).trim()
    const m = /^(\d+(?:\.\d+)?)\s*(Gi|Mi|G|M|K|Ki)?$/.exec(text)
    if (!m) throw new Error(`invalid memory quantity: ${raw} (try '512Mi' or '4Gi')`)
    const n = Number(m[1])
    const unit = m[2]
    const mb = unit === 'Gi' ? n * 1024
      : unit === 'G' ? (n * 1_000_000_000) / (1024 * 1024)
        : unit === 'Mi' || unit === 'M' ? (unit === 'M' ? (n * 1_000_000) / (1024 * 1024) : n)
          : unit === 'Ki' || unit === 'K' ? n / 1024
            : n / (1024 * 1024)
    return Math.round(mb)
  }

  // ---- postgres: management wakes, observability does not (decision 48) --------------------------

  /** Before a MANAGEMENT query (password, databases, extensions): an explicit operation, so it
   *  wakes the instance through the api door. Re-entrant: the caller already holds the key. */
  private async ensurePgAwake(branch: Branch, serviceId: string): Promise<void> {
    await this.wake(this.serviceKey(branch, serviceId), { door: 'api' })
  }

  /** Before an OBSERVABILITY query: a sleeping database reports that it is sleeping instead of
   *  being woken by a dashboard poll. `server.ts` maps this message to 503. The snapshot is taken
   *  fresh, because a stale one would refuse a database that is up. Only `asleep` and `starting`
   *  refuse: a container that crashed is not sleeping, and letting the query fail says so honestly. */
  private async assertPgAwake(branch: Branch, serviceId: string): Promise<void> {
    await this.scheduler.refreshStates()
    const live = this.stateOf(this.serviceKey(branch, serviceId))
    if (live === 'asleep' || live === 'starting') {
      throw new Error('database is sleeping: it wakes on the next connection')
    }
  }

  /** Run one management query with the instance awake and the key held for its duration. */
  private async pgManage<T>(branch: Branch, serviceId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.serviceKey(branch, serviceId)
    return this.withOp([key], async () => {
      await this.ensurePgAwake(branch, serviceId)
      return fn()
    })
  }
  // ---- end region WP3 ----

  // ---- region WP4 (data dir) ----
  /** The engine's default `DataDirOps`: the process-wide `DataDir`, resolved on the first CALL, not
   *  at class definition, so constructing an Engine still reads no config and touches no disk.
   *  `main.ts` passes the instance it probed at boot; tests pass a recorder. (The name is the
   *  scaffold's; the body is no longer a no-op.) */
  private static readonly NOOP_DATA: DataDirOps = lazyDataDirOps()
  readonly data: DataDirOps
  /** True while migrateLegacyData runs: the sleep sweep stays inert while containers are being
   *  stopped and recreated by the migration (decision 24). */
  booting = false
  /** Host paths under `cfg.dataDir`, keyed by IMMUTABLE ids: a rename must never detach data
   *  (decision 16, contract 00 section 12). */
  layout(): { pg(ref: string, dataId: string): string; vol(ref: string, volId: string): string; md(ref: string, type: ManagedDbType, dataId: string): string; branchRoots(ref: string): string[] } {
    return dataLayout(this.cfg.dataDir)
  }
  /** The compute group's /data bind mount. Created before the deploy, 0777 because a user image may
   *  run as any uid (the parent tree is 0700, so the box is not open). A missing bind source makes
   *  `--mount type=bind` fail the start, which is why this is not lazy. */
  volumeMount(project: Project, branch: Branch, group: string): { hostPath: string } | undefined {
    const vol = project.computeVolumes?.[group]
    if (!vol) return undefined
    const hostPath = this.layout().vol(this.ref(project, branch), vol.id)
    ensureDirSync(hostPath, 0o777)
    return { hostPath }
  }
  /** Reflink (or plain-copy) every /data volume of the source branch onto the target. Runs BEFORE
   *  the clone's redeploy loop, so the new containers start on their own copy. The source app keeps
   *  running: the copy is crash-consistent, exactly like the database clone. */
  async forkVolumes(project: Project, source: Branch, target: Branch): Promise<Array<{ group: string; method: 'reflink' | 'copy'; ms: number }>> {
    const out: Array<{ group: string; method: 'reflink' | 'copy'; ms: number }> = []
    const srcRef = this.ref(project, source)
    const dstRef = this.ref(project, target)
    for (const group of Object.keys(source.apps)) {
      const vol = project.computeVolumes?.[group]
      if (!vol) continue
      const from = this.layout().vol(srcRef, vol.id)
      if (!existsSync(from)) continue
      const to = this.layout().vol(dstRef, vol.id)
      await this.data.ensureDir(to, 0o777)
      const r = await this.data.cloneTree(from, to)
      out.push({ group, method: r.method, ms: r.ms })
    }
    return out
  }
  /** The boot probe's answer (decision 23): `warning` is set when the probe degraded to copying. */
  dataCapabilities(): { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string } {
    return this.dataCaps ?? probedCapabilities()
  }
  private dataCaps: { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string } | undefined
  /** main.ts hands the boot probe's result to the engine so `insta` can report it without probing
   *  again. */
  setDataCapabilities(caps: { dataDir: string; reflink: boolean; engine: 'inprocess' | 'helper' | 'cp-c'; warning?: string }): void {
    this.dataCaps = caps
  }
  /** One boot migration of branches still storing data in docker volumes and container layers
   *  (decision 24). Resumable and idempotent; a branch it could not finish keeps
   *  `dataVersion: undefined`, and `createBranch` from such a branch throws. */
  async migrateLegacyData(): Promise<{ migrated: string[]; skipped: string[]; failed: Array<{ ref: string; error: string }> }> {
    return migrateLegacyData({
      cfg: this.cfg,
      data: this.data,
      layout: () => this.layout(),
      ref: (branch) => this.ref(this.getProject(branch.projectId)!, branch),
      query: (container, sql) => this.db.query(container, sql),
      provisionManaged: (t, opts) => this.managedDb.provision(t, opts),
      redeploy: (projectId, branchName, group, opts) => this.deploy(projectId, branchName, { ...opts, group }).then(() => undefined),
    })
  }
  /** The per-branch guard the plan's message names: a fork of a branch whose bytes still live in a
   *  docker volume would clone an empty directory. */
  private assertMigrated(branch: Branch): void {
    if (branch.dataVersion !== 1) {
      throw new Error(`branch ${branch.name} still stores data in docker volumes; restart the daemon to retry the migration`)
    }
  }
  /** Every managed sub-directory of one service, created before the container starts (a missing
   *  bind source fails `--mount type=bind`). */
  private async ensureManagedDirs(ref: string, type: ManagedDbType, dataId: string): Promise<string> {
    const dir = this.layout().md(ref, type, dataId)
    await this.data.ensureDir(dir, 0o700)
    for (const p of dataPaths(type)) await this.data.ensureDir(join(dir, p.sub), 0o700)
    return dir
  }
  /** The fork result of the branch currently being provisioned, read once by `createBranch` for the
   *  `branch.created` payload (decision 39) and then dropped. */
  private forkResults = new Map<string, { method: 'reflink' | 'basebackup'; ms: number }>()
  // ---- end region WP4 ----

  // ---- region WP5 (templates/parity) ----

  /** The bundled template registry (`cfg.templatesDir`). Reads no file until a route asks. */
  readonly templates: TemplateCatalog
  private executorInstance: TemplateExecutor | undefined
  /** The template executor, created on first use so nothing has to wire it up: main.ts just calls
   *  `abandonStale()` at boot. Assignable like `router`, because an executor needs the engine that
   *  owns it — a test builds the engine, then hands it one with a fake health probe. */
  get executor(): TemplateExecutor {
    return (this.executorInstance ??= new TemplateExecutor(this))
  }
  set executor(ex: TemplateExecutor) { this.executorInstance = ex }

  /** User secrets bound to ONE service on ONE branch, by name. The template executor reads back
   *  what a previous attempt wrote (the deployment record stores refs, never values). */
  boundSecrets(projectId: string, branchName: string, service: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const u of loadState().userSecrets[projectId] ?? []) {
      if (u.branch === branchName && u.service === service) out[u.name] = u.value
    }
    return out
  }

  /** The project's postgres registrations, in creation order (the OLDEST holds the canonical
   *  unsuffixed `DATABASE_URL` alias, computed at read time so a removal shifts it). */
  private dbList(projectId: string): NonNullable<Project['dbServices']> {
    return this.getProject(projectId)?.dbServices ?? []
  }
  /** The project's storage registrations, in creation order (the oldest holds the S3 aliases). */
  private stList(projectId: string): NonNullable<Project['storageServices']> {
    return this.getProject(projectId)?.storageServices ?? []
  }

  /** One postgres service's handle on one branch. READ from the row; derived only for a row a
   *  migration has not reached yet (decision 17). */
  private dbHandle(project: Project, branch: Branch, serviceId: string): { url: string; container: string; dataId: string } | undefined {
    const row = branch.databases?.[serviceId]
    if (row) return row
    const reg = this.dbList(project.id).find((d) => d.id === serviceId)
    if (!reg || branch.dbUrl === undefined) return undefined
    return { url: branch.dbUrl, container: `io-${this.ref(project, branch)}-pg`, dataId: reg.dataId }
  }

  /** One storage service's handle on one branch (bucket + its minted credential env). */
  private bucketHandle(project: Project, branch: Branch, serviceId: string): { bucket: string; env: Record<string, string>; public?: boolean } | undefined {
    const row = branch.buckets?.[serviceId]
    if (row) return row
    if (!this.stList(project.id).some((s) => s.id === serviceId) || branch.bucket === undefined) return undefined
    return { bucket: branch.bucket, env: branch.s3 ?? {}, public: branch.storagePublic ?? false }
  }

  /** Every service id a branch materialises, in the order provisionBranch creates them. */
  private branchServiceIds(project: Project): string[] {
    return [...this.dbList(project.id).map((d) => d.id), ...this.managedList(project.id).map((m) => m.id)]
  }

  // ---- env assembly (contract 00 section 10, plan 05 section 5) ----------------------------------

  /** Minted postgres credentials: every service SUFFIXED (`DATABASE_URL_<NAME>`), the oldest also
   *  unsuffixed. The stored container-host DSN is what a container dials (docker DNS on the branch
   *  network resolves it in both run modes); the host-facing lane form is what `credentials()`
   *  returns. */
  private dbSecretsFor(project: Project, branch: Branch): Record<string, string> {
    const out: Record<string, string> = {}
    let aliased = false
    for (const d of this.dbList(project.id)) {
      const row = this.dbHandle(project, branch, d.id)
      if (!row) continue
      out[`DATABASE_URL_${envSuffix(d.name)}`] = row.url
      if (!aliased) { aliased = true; out.DATABASE_URL = row.url }
    }
    return out
  }

  /** Minted storage credentials on the same suffix + alias rule as postgres and managed. */
  private storageSecretsFor(project: Project, branch: Branch): Record<string, string> {
    const out: Record<string, string> = {}
    let aliased = false
    for (const s of this.stList(project.id)) {
      const row = this.bucketHandle(project, branch, s.id)
      if (!row) continue
      Object.assign(out, suffixBundle(row.env, s.name))
      if (!aliased) { aliased = true; Object.assign(out, row.env) }
    }
    return out
  }

  /** Env names one service mints (names only, for the inventory routes): always its SUFFIXED set,
   *  plus the canonical unsuffixed keys when it is the oldest of its type and therefore holds the
   *  aliases. Derived from the same rule the value assembly above applies. */
  private mintedNamesOf(project: Project, serviceId: string): string[] {
    const parsed = parseServiceId(serviceId)
    if (!parsed) return []
    if (parsed.type === 'postgres') {
      const canonical = this.dbList(project.id)[0]?.id === parsed.serviceId
      return [...(canonical ? ['DATABASE_URL'] : []), `DATABASE_URL_${envSuffix(parsed.name)}`]
    }
    if (parsed.type === 'storage') {
      const branch = this.listBranches(project.id).find((b) => b.isDefault) ?? this.listBranches(project.id)[0]
      const env = branch ? this.bucketHandle(project, branch, parsed.serviceId)?.env : undefined
      const keys = env ? Object.keys(env) : [...CANONICAL_KEYS.storage]
      const canonical = this.stList(project.id)[0]?.id === parsed.serviceId
      return [...(canonical ? keys : []), ...keys.map((k) => `${k}_${envSuffix(parsed.name)}`)]
    }
    if (isManagedDbType(parsed.type)) return this.mintedManagedNames({ type: parsed.type, name: parsed.name })
    return []
  }

  /** Secrets bound INTO one compute group by `${{services.x.KEY}}` bindings: `envName` takes the
   *  named credential of the named source service. Bindings bypass `isReservedSecret` by design —
   *  renaming a platform credential into an app's own env name is exactly what they are for. */
  private bindingsFor(project: Project, branch: Branch, group: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const b of branch.bindings ?? []) {
      if (b.target !== `compute/${group}`) continue
      const [type, name] = [b.source.slice(0, b.source.indexOf('/')), b.source.slice(b.source.indexOf('/') + 1)]
      const sid = type === 'postgres' ? pgServiceId(name)
        : type === 'storage' ? storageServiceId(name)
        : isManagedDbType(type) ? managedServiceId(type, name)
        : undefined
      if (!sid) continue
      const value = this.credentialsOn(project, branch, sid)[b.sourceName]
      if (value !== undefined) out[b.envName] = value
    }
    return out
  }

  /** The env one compute deploy receives, low precedence to high: minted postgres, minted storage,
   *  minted managed databases, user secrets scoped to this group, then bindings. */
  envFor(project: Project, branch: Branch, group: string): Record<string, string> {
    return {
      ...this.dbSecretsFor(project, branch),
      ...this.storageSecretsFor(project, branch),
      ...this.managedSecretsFor(project.id, branch),
      ...this.deploySecretsFor(project.id, branch.name, group),
      ...this.bindingsFor(project, branch, group),
    }
  }

  /** The canonical credential bundle of ONE service on ONE branch, host-facing: the DSN and host
   *  values point at the lane a client outside the branch network dials (WP2's `laneAddress`),
   *  which is what `insta db url` prints and what a binding reads. Compute services mint nothing. */
  private credentialsOn(project: Project, branch: Branch, serviceId: string): Record<string, string> {
    const parsed = parseServiceId(serviceId)
    if (!parsed) return {}
    if (parsed.type === 'postgres') {
      const row = this.dbHandle(project, branch, serviceId)
      if (!row) return {}
      return { DATABASE_URL: this.laneUrl(project, branch, serviceId, row.url) }
    }
    if (parsed.type === 'storage') {
      const row = this.bucketHandle(project, branch, serviceId)
      return row ? { ...row.env } : {}
    }
    if (isManagedDbType(parsed.type)) {
      const cred = branch.managed?.[serviceId]
      if (!cred) return {}
      const lane = this.laneAddress(project, branch, serviceId)
      return laneBundle(parsed.type, lane.host, lane.port, cred.password, lane.tls)
    }
    return {}
  }

  /** A stored container-host DSN rewritten onto the service's lane, `sslmode=require` when the lane
   *  terminates TLS (contract 00 section 10). */
  private laneUrl(project: Project, branch: Branch, serviceId: string, stored: string): string {
    const lane = this.laneAddress(project, branch, serviceId)
    let u: URL
    try { u = new URL(stored) } catch { return stored }
    u.host = `${lane.host}:${lane.port}`
    if (lane.tls) u.searchParams.set('sslmode', 'require')
    return u.toString()
  }

  /** GET /projects/:id/services/:sid/credentials. */
  credentials(projectId: string, serviceId: string, branchName?: string): Record<string, string> {
    const { branch, serviceId: sid } = this.resolveSid(projectId, serviceId, branchName)
    const project = this.getProject(projectId)!
    this.serviceOf(projectId, sid) // 404 for an id no registration claims
    return this.credentialsOn(project, branch, sid)
  }

  // ---- branch-qualified service ids (decision 49) ------------------------------------------------

  /** The id a `services()` row carries: bare on the default branch, `<branchId>:<serviceId>`
   *  elsewhere. The CLI takes an id from the branch-scoped list and calls credentials/state/stop
   *  with NO branch, so a bare id off the default branch would silently act on main. */
  qualifiedId(branch: Branch, serviceId: string): string {
    return branch.isDefault ? serviceId : `${branch.id}:${serviceId}`
  }

  /** Resolve a possibly-qualified sid to its branch and BARE service id: the qualifier wins, then
   *  `?branch`, then the default branch. A qualifier naming a branch that is gone (or belongs to
   *  another project) is a 404, never a silent fall-through to main. */
  resolveSid(projectId: string, sid: string, branchQuery?: string): { branch: Branch; serviceId: string } {
    const parsed = parseServiceId(sid)
    const serviceId = parsed?.serviceId ?? sid
    if (parsed?.branchId !== undefined) {
      const branch = loadState().branches[parsed.branchId]
      if (!branch || branch.projectId !== projectId) throw new Error('branch not found')
      return { branch, serviceId }
    }
    const { branch } = this.branchOrThrow(projectId, branchQuery)
    return { branch, serviceId }
  }

  // ---- postgres service registrations -----------------------------------------------------------

  private static NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/

  private assertServiceName(name: string): void {
    if (!Engine.NAME_RE.test(name)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
  }

  /** The cloud's per-type branch cap, minus its dash and upgrade hint (there is no plan to buy). */
  private assertTypeCap(count: number, type: string): void {
    if (count >= this.cfg.services.maxPerType) {
      throw new Error(`branch has reached this plan's limit of ${this.cfg.services.maxPerType} ${type} services (INSTA_OSS_MAX_SERVICES_PER_TYPE)`)
    }
  }

  /** Register a postgres service and materialise one container per branch, like a managed database:
   *  oss services are project-level registrations, so the service appears on EVERY branch. */
  async addDbService(projectId: string, name: string, opts: { templateDeploymentId?: string } = {}): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      this.assertServiceName(name)
      if (this.dbList(projectId).some((d) => d.name === name)) throw new Error('service already exists on this branch')
      this.assertTypeCap(this.dbList(projectId).length, 'postgres')
      const branches = this.listBranches(projectId)
      const entry = { id: pgServiceId(name), name, dataId: randomUUID().slice(0, 8), createdAt: Date.now(), ...(opts.templateDeploymentId ? { templateDeploymentId: opts.templateDeploymentId } : {}) }
      // ONE synchronous mutate reserves the name and every hostname it will mint, before any
      // provisioning await (decision 51).
      mutate((st) => {
        for (const b of branches) this.assertHostFree(this.labelFor('postgres', name, this.ref(project, b)))
        const pr = st.projects[projectId]
        pr.dbServices = [...(pr.dbServices ?? []), entry]
      })
      const done: Array<{ branch: Branch; container: string; dataDir: string }> = []
      try {
        for (const b of branches) {
          const ref = this.ref(project, b)
          const container = pgContainerName(ref, name)
          const dataDir = this.layout().pg(ref, entry.dataId)
          const { url } = await this.db.provision({ container, network: b.network, dataDir }, { publishLoopback: this.cfg.mode === 'local', limits: this.limitsFor(project, entry.id) })
          done.push({ branch: b, container, dataDir })
          const host = this.hostFor('postgres', name, ref)
          mutate((st) => { (st.branches[b.id].databases ??= {})[entry.id] = { url, container, dataId: entry.dataId, host } })
          this.scheduler.register([this.serviceKey(b, entry.id)])                                   // WP3
        }
      } catch (e) {
        for (const d of done) {
          await this.db.destroy(d.container).catch(() => {})
          await this.data.remove(d.dataDir).catch(() => {})
          mutate((st) => { delete st.branches[d.branch.id].databases?.[entry.id] })
        }
        mutate((st) => {
          const pr = st.projects[projectId]
          pr.dbServices = (pr.dbServices ?? []).filter((d) => d.id !== entry.id)
        })
        throw e
      }
      // The new lane must be listening before `insta db url` is followed by a psql.
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.added', { type: 'postgres', name })
      return { id: entry.id, type: 'postgres', name, status: 'ready', pg_version: PG_VERSION }
    })
  }

  /** Remove a postgres service from every branch (the data goes with it) and unregister it. */
  async removeDbService(projectId: string, serviceId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const reg = this.dbList(projectId).find((d) => d.id === serviceId)
    if (!reg) throw new Error('service not found')
    const branches = this.listBranches(projectId)
    return this.withOp(branches.map((b) => this.serviceKey(b, serviceId)), async () => {
      const t = newTeardown()
      for (const b of branches) {
        const row = this.dbHandle(project, b, serviceId)
        if (row) await count(t, () => this.db.destroy(row.container))
        await count(t, () => this.data.remove(this.layout().pg(this.ref(project, b), reg.dataId)))
        mutate((st) => {
          delete st.branches[b.id].databases?.[serviceId]
          st.branches[b.id].bindings = (st.branches[b.id].bindings ?? []).filter((x) => x.source !== `postgres/${reg.name}`)
        })
      }
      mutate((st) => {
        const pr = st.projects[projectId]
        pr.dbServices = (pr.dbServices ?? []).filter((d) => d.id !== serviceId)
        st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => u.service !== `postgres/${reg.name}`)
      })
      this.scheduler.forget(branches.map((b) => this.serviceKey(b, serviceId)))                      // WP3
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.removed', { type: 'postgres', name: reg.name })
      return t
    })
  }

  /** Rename a postgres service everywhere its name appears: the registration and its id, every
   *  branch's container and minted hostname, bindings and service-bound user secrets. The data
   *  directory keeps its immutable `dataId` (decision 16). */
  async renameDbService(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      const reg = this.dbList(projectId).find((d) => d.id === serviceId)
      if (!reg) throw new Error('service not found')
      this.assertServiceName(newName)
      if (newName === reg.name) return { id: reg.id, type: 'postgres', name: reg.name, status: 'ready', pg_version: PG_VERSION }
      if (this.dbList(projectId).some((d) => d.name === newName)) throw new Error(`postgres service "${newName}" already exists`)
      const newId = pgServiceId(newName)
      const branches = this.listBranches(projectId)
      for (const b of branches) this.assertHostFree(this.labelFor('postgres', newName, this.ref(project, b)))
      for (const b of branches) {
        const row = this.dbHandle(project, b, serviceId)
        if (!row) continue
        const ref = this.ref(project, b)
        const container = pgContainerName(ref, newName)
        if (this.db.rename) await this.db.rename(row.container, container)
        const host = this.hostFor('postgres', newName, ref)
        mutate((st) => {
          const rows = st.branches[b.id].databases
          if (!rows?.[serviceId]) return
          rows[newId] = { ...rows[serviceId], url: rows[serviceId].url.replace(row.container, container), container, host }
          delete rows[serviceId]
          for (const x of st.branches[b.id].bindings ?? []) if (x.source === `postgres/${reg.name}`) x.source = `postgres/${newName}`
        })
        this.scheduler.rekey(this.serviceKey(b, serviceId), this.serviceKey(b, newId))                // WP3
      }
      mutate((st) => {
        const pr = st.projects[projectId]
        pr.dbServices = (pr.dbServices ?? []).map((d) => (d.id === serviceId ? { ...d, id: newId, name: newName } : d))
        for (const u of st.userSecrets[projectId] ?? []) if (u.service === `postgres/${reg.name}`) u.service = `postgres/${newName}`
      })
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.rename', { type: 'postgres', from: reg.name, to: newName })
      return { id: newId, type: 'postgres', name: newName, status: 'ready', pg_version: PG_VERSION }
    })
  }

  // ---- storage service registrations -------------------------------------------------------------

  /** Register a storage service and provision one bucket per branch. */
  async addStorageService(projectId: string, name: string, opts: { public?: boolean } = {}): Promise<ServiceRow> {
    return this.serialize('provision', async () => {
      const project = this.getProject(projectId)
      if (!project) throw new Error('project not found')
      this.assertServiceName(name)
      if (this.stList(projectId).some((s) => s.name === name)) throw new Error('service already exists on this branch')
      this.assertTypeCap(this.stList(projectId).length, 'storage')
      const branches = this.listBranches(projectId)
      const entry = { id: storageServiceId(name), name, createdAt: Date.now(), ...(opts.public !== undefined ? { public: opts.public } : {}) }
      mutate((st) => {
        const pr = st.projects[projectId]
        pr.storageServices = [...(pr.storageServices ?? []), entry]
      })
      const done: Array<{ branch: Branch; bucket: string }> = []
      try {
        for (const b of branches) {
          const st = await this.storage.provision(this.ref(project, b), b.network, name)
          done.push({ branch: b, bucket: st.bucket })
          if (opts.public === true && this.storage.setAccess) await this.storage.setAccess(st.bucket, b.network, true)
          mutate((s) => { (s.branches[b.id].buckets ??= {})[entry.id] = { bucket: st.bucket, env: st.env, ...(opts.public !== undefined ? { public: opts.public } : {}) } })
        }
      } catch (e) {
        for (const d of done) {
          await this.storage.destroy(d.bucket, d.branch.network).catch(() => {})
          mutate((s) => { delete s.branches[d.branch.id].buckets?.[entry.id] })
        }
        mutate((s) => {
          const pr = s.projects[projectId]
          pr.storageServices = (pr.storageServices ?? []).filter((x) => x.id !== entry.id)
        })
        throw e
      }
      // The bucket vhost is a route in server mode, and the deploy alias list just grew.
      this.router.invalidate()
      this.emit(projectId, null, 'resource', 'service.added', { type: 'storage', name })
      return { id: entry.id, type: 'storage', name, status: 'ready', public: opts.public ?? false }
    })
  }

  /** Remove a storage service: purge and delete its bucket on every branch, unregister. */
  async removeStorageService(projectId: string, serviceId: string): Promise<Teardown> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const reg = this.stList(projectId).find((s) => s.id === serviceId)
    if (!reg) throw new Error('service not found')
    const t = newTeardown()
    for (const b of this.listBranches(projectId)) {
      const row = this.bucketHandle(project, b, serviceId)
      if (row) await count(t, () => this.storage.destroy(row.bucket, b.network))
      mutate((st) => {
        delete st.branches[b.id].buckets?.[serviceId]
        st.branches[b.id].bindings = (st.branches[b.id].bindings ?? []).filter((x) => x.source !== `storage/${reg.name}`)
      })
    }
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.storageServices = (pr.storageServices ?? []).filter((s) => s.id !== serviceId)
      st.userSecrets[projectId] = (st.userSecrets[projectId] ?? []).filter((u) => u.service !== `storage/${reg.name}`)
    })
    this.router.invalidate()
    this.emit(projectId, null, 'resource', 'service.removed', { type: 'storage', name: reg.name })
    return t
  }

  /** Rename a storage service: a re-key only. The bucket handle is immutable (its name is baked
   *  into every object URL and into the access key scoped to it), exactly like the cloud. */
  async renameStorageService(projectId: string, serviceId: string, newName: string): Promise<ServiceRow> {
    const project = this.getProject(projectId)
    if (!project) throw new Error('project not found')
    const reg = this.stList(projectId).find((s) => s.id === serviceId)
    if (!reg) throw new Error('service not found')
    this.assertServiceName(newName)
    const row = (name: string, id: string): ServiceRow => ({ id, type: 'storage', name, status: 'ready', public: reg.public ?? false })
    if (newName === reg.name) return row(reg.name, reg.id)
    if (this.stList(projectId).some((s) => s.name === newName)) throw new Error(`storage service "${newName}" already exists`)
    const newId = storageServiceId(newName)
    mutate((st) => {
      const pr = st.projects[projectId]
      pr.storageServices = (pr.storageServices ?? []).map((s) => (s.id === serviceId ? { ...s, id: newId, name: newName } : s))
      for (const b of Object.values(st.branches)) {
        if (b.projectId !== projectId || !b.buckets?.[serviceId]) continue
        b.buckets[newId] = b.buckets[serviceId]
        delete b.buckets[serviceId]
        for (const x of b.bindings ?? []) if (x.source === `storage/${reg.name}`) x.source = `storage/${newName}`
      }
      for (const u of st.userSecrets[projectId] ?? []) if (u.service === `storage/${reg.name}`) u.service = `storage/${newName}`
    })
    this.router.invalidate()
    this.emit(projectId, null, 'resource', 'service.rename', { type: 'storage', from: reg.name, to: newName })
    return row(newName, newId)
  }

  // ---- bindings (`${{services.x.KEY}}`) ----------------------------------------------------------

  /** Bind one credential of one service into one compute group's env under a chosen name. */
  setBinding(projectId: string, branchName: string, b: { envName: string; target: string; source: string; sourceName: string }): void {
    const { branch } = this.branchOrThrow(projectId, branchName)
    if (!ENV_NAME_RE.test(b.envName)) throw new Error(`invalid env name: ${b.envName}`)
    mutate((st) => {
      const row = st.branches[branch.id]
      const list = (row.bindings ??= [])
      const i = list.findIndex((x) => x.envName === b.envName && x.target === b.target)
      if (i === -1) list.push({ ...b })
      else list[i] = { ...b }
    })
    this.emit(projectId, branch.name, 'govern', 'secrets.write', { name: b.envName, scope: branch.name, service: b.target, binding: b.source })
  }

  unsetBinding(projectId: string, branchName: string, envName: string, target: string): void {
    const { branch } = this.branchOrThrow(projectId, branchName)
    mutate((st) => {
      const row = st.branches[branch.id]
      row.bindings = (row.bindings ?? []).filter((x) => !(x.envName === envName && x.target === target))
    })
  }

  listBindings(projectId: string, branchName: string, target?: string): NonNullable<Branch['bindings']> {
    const { branch } = this.branchOrThrow(projectId, branchName)
    return (branch.bindings ?? []).filter((x) => (target ? x.target === target : true))
  }

  // ---- database routes over several postgres services (plan 05 section 6) -----------------------

  /** Which postgres service a `/database/*` request means: `?group=`, or the project's sole one. */
  dbTarget(projectId: string, branchName?: string, group?: string): { project: Project; branch: Branch; serviceId: string; container: string; url: string } {
    const { project, branch } = this.branchOrThrow(projectId, branchName)
    const list = this.dbList(projectId)
    const reg = group !== undefined
      ? list.find((d) => d.name === group) ?? (() => { throw new Error(`postgres service not found: ${group}`) })()
      : list.length === 1 ? list[0]
        : list.length === 0 ? (() => { throw new Error('no postgres service in this project (add one with `insta services add postgres <name>`)') })()
          : (() => { throw new Error(`multiple postgres services - specify one: ${list.map((d) => d.name).sort().join(', ')}`) })()
    const row = this.dbHandle(project, branch, reg.id)
    if (!row) throw new Error(`postgres service not found: ${reg.name}`)
    return { project, branch, serviceId: reg.id, container: row.container, url: row.url }
  }

  // ---- boot-time repair --------------------------------------------------------------------------

  /** Best-effort rename of a legacy `io-<ref>-pg` container onto the `io-<ref>-pg-db` handle
   *  (decision 17). A no-op after WP4's data migration, which renames while moving the bytes; kept
   *  for an install that ran with `INSTA_OSS_DATA_MIGRATE=0`. */
  async migrateLegacyContainers(): Promise<void> {
    for (const b of Object.values(loadState().branches)) {
      const project = this.getProject(b.projectId)
      if (!project) continue
      const row = b.databases?.['pg-db']
      const legacy = `io-${this.ref(project, b)}-pg`
      if (!row || row.container !== legacy) continue
      const container = pgContainerName(this.ref(project, b), 'db')
      try { await this.db.rename?.(legacy, container) } catch { continue }
      mutate((st) => {
        const target = st.branches[b.id].databases?.['pg-db']
        if (!target) return
        target.url = target.url.replace(legacy, container)
        target.container = container
      })
      this.router.invalidate()
    }
  }
  // ---- end region WP5 ----
}
