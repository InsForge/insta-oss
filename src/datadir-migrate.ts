// One-time boot migration of installs that predate the data directory (decision 24). Before it,
// every byte lived inside a container layer or a docker NAMED volume, which cannot be reflinked and
// disappears with a `docker rm -v`; after it, each branch's bytes sit under `cfg.dataDir` on bind
// mounts and `Branch.dataVersion` is 1.
//
// Three properties matter more than speed here:
//   - RESUMABLE: every step checks the destination first (`hasPgData`, `isEmptyOrMissing`), so a
//     daemon killed mid-copy redoes only what it did not finish;
//   - NON-BLOCKING: a branch that cannot be migrated is logged and skipped, the daemon still boots,
//     and only `createBranch` from that branch refuses (a fork would clone an empty directory);
//   - NO BUFFERING: the bytes move container-to-bind-mount inside the helper image
//     (`data.copyFromContainerVolume`), never through the daemon.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { docker } from './docker'
import { pgAppendHba, pgRun, pgWaitReady } from './adapters/postgres'
import { dataPaths, managedContainerName, pgContainerName } from './manageddb'
import { loadState, mutate } from './state'
import type { Config } from './config'
import type { Branch, DataDirOps, ManagedDbTarget, ManagedDbType, Project, ServiceLimits } from './types'

const LEGACY_PGDATA = '/var/lib/postgresql/data'

export interface MigrateDeps {
  cfg: Config
  data: DataDirOps
  layout(): { pg(ref: string, dataId: string): string; vol(ref: string, volId: string): string; md(ref: string, type: ManagedDbType, dataId: string): string; branchRoots(ref: string): string[] }
  ref(branch: Branch): string
  /** `db.query`, for the `pg_reload_conf()` after the hba line. */
  query(container: string, sql: string): Promise<string>
  /** `managedDb.provision`, to re-create a managed container on its new bind mounts. */
  provisionManaged(t: ManagedDbTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<void>
  /** `engine.deploy`, to re-create one compute container on its new bind mount while preserving the
   *  recorded lifecycle intent. */
  redeploy(projectId: string, branchName: string, group: string, opts: { image: string; port: number; hostPort?: number }): Promise<void>
}

export interface MigrateResult { migrated: string[]; skipped: string[]; failed: Array<{ ref: string; error: string }> }

export async function migrateLegacyData(deps: MigrateDeps): Promise<MigrateResult> {
  const out: MigrateResult = { migrated: [], skipped: [], failed: [] }
  if (!deps.cfg.data.migrate) return out
  const s = loadState()
  for (const branch of Object.values(s.branches)) {
    const project = s.projects[branch.projectId]
    if (!project) continue
    const ref = deps.ref(branch)
    if (branch.dataVersion === 1) { out.skipped.push(ref); continue }
    try {
      const touched = await migrateBranch(deps, project, branch)
      mutate((st) => { const b = st.branches[branch.id]; if (b) b.dataVersion = 1 })
      if (touched) out.migrated.push(ref)
      else out.skipped.push(ref)
    } catch (e) {
      out.failed.push({ ref, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (out.migrated.length || out.failed.length) {
    console.log(`data migration: ${out.migrated.length} migrated, ${out.skipped.length} skipped, ${out.failed.length} failed`)
    for (const f of out.failed) console.warn(`data migration failed for ${f.ref}: ${f.error}`)
  }
  return out
}

/** True when this branch actually had something to move. */
async function migrateBranch(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const pg = await migratePostgres(deps, project, branch)
  const vols = await migrateVolumes(deps, project, branch)
  const managed = await migrateManaged(deps, project, branch)
  return pg || vols || managed
}

// ---- postgres ----

async function migratePostgres(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  const entry = (project.dbServices ?? []).find((d) => d.id === 'pg-db')
  const name = entry?.name ?? 'db'
  const dataId = entry?.dataId ?? branch.databases?.['pg-db']?.dataId ?? 'db'
  const target = deps.layout().pg(ref, dataId)
  const legacy = legacyPgContainer(branch, ref)
  const fresh = pgContainerName(ref, name)
  const legacyExists = legacy !== fresh && (await exists(legacy))
  const freshExists = await exists(fresh)

  // fully migrated already
  if (!legacyExists && freshExists) return false

  let wasRunning = true
  if (legacyExists) {
    wasRunning = (await inspect(legacy, '{{.State.Running}}')) === 'true'
    await docker(['stop', legacy]).catch(() => { /* already down */ })
    if (!(await deps.data.hasPgData(target))) {
      await deps.data.ensureDir(target, 0o700)
      await deps.data.copyFromContainerVolume({ container: legacy }, LEGACY_PGDATA, target)
      if (!(await deps.data.hasPgData(target))) throw new Error(`copy of ${legacy} left no PG_VERSION in ${target}`)
    }
    await docker(['rm', '-f', '-v', legacy]).catch(() => { /* raced away */ })
  } else if (!(await deps.data.hasPgData(target))) {
    // nothing to migrate and nothing migrated: a branch whose database was never provisioned
    return false
  }

  // re-create under the new name on the bind mount. The directory is non-empty, so the image skips
  // initdb and the existing password, hba and conf travel with the files: only the DSN's HOST moves.
  await pgRun({ container: fresh, network: branch.network, dataDir: target }, { publishLoopback: deps.cfg.mode === 'local' })
  await pgWaitReady(fresh)
  await pgAppendHba(fresh)
  await deps.query(fresh, 'select pg_reload_conf()').catch(() => { /* reload is best effort */ })
  if (!wasRunning) await docker(['stop', fresh]).catch(() => {})
  mutate((st) => {
    const b = st.branches[branch.id]
    if (!b) return
    const url = b.databases?.['pg-db']?.url ?? b.dbUrl
    const moved = url ? swapUrlHost(url, fresh) : url
    if (b.databases?.['pg-db']) {
      b.databases['pg-db'].container = fresh
      if (moved) b.databases['pg-db'].url = moved
      b.databases['pg-db'].dataId = dataId
    }
    if (moved) b.dbUrl = moved
  })
  return true
}

/** The handle a legacy row carries (`io-<ref>-pg`), read from state when present (decision 17). */
function legacyPgContainer(branch: Branch, ref: string): string {
  return branch.databases?.['pg-db']?.container ?? `io-${ref}-pg`
}

// ---- compute /data volumes ----

async function migrateVolumes(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  let touched = false
  for (const [group, app] of Object.entries(branch.apps ?? {})) {
    const vol = project.computeVolumes?.[group]
    if (!vol) continue
    const legacy = `io-${ref}-data-${vol.id}`
    if (!(await volumeExists(legacy))) continue
    const target = deps.layout().vol(ref, vol.id)
    if (await deps.data.isEmptyOrMissing(target)) {
      await deps.data.ensureDir(target, 0o777)
      await deps.data.copyFromContainerVolume({ volume: legacy }, '/src', target)
    }
    // Recreate the container on the bind mount. `deploy` re-asserts the recorded lifecycle intent,
    // so a service the developer had stopped stays stopped.
    await deps.redeploy(branch.projectId, branch.name, group, { image: app.image, port: app.port, hostPort: app.hostPort })
    await docker(['volume', 'rm', legacy]).catch(() => { /* still referenced; the next boot retries */ })
    touched = true
  }
  return touched
}

// ---- managed databases ----

async function migrateManaged(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  let touched = false
  for (const m of project.managedServices ?? []) {
    const dataId = m.dataId ?? randomUUID().slice(0, 8)
    if (!m.dataId) {
      mutate((st) => {
        const list = st.projects[project.id]?.managedServices
        const row = list?.find((x) => x.id === m.id)
        if (row) row.dataId = dataId
      })
    }
    const container = managedContainerName(ref, m.type, m.name)
    if (!(await exists(container))) continue
    const dir = deps.layout().md(ref, m.type, dataId)
    const mounted = await hasMount(container, dir)
    if (mounted) continue
    const wasRunning = (await inspect(container, '{{.State.Running}}')) === 'true'
    await docker(['stop', container]).catch(() => {})
    for (const p of dataPaths(m.type)) {
      const target = join(dir, p.sub)
      if (!(await deps.data.isEmptyOrMissing(target))) continue
      await deps.data.ensureDir(target, 0o700)
      await deps.data.copyFromContainerVolume({ container }, p.containerPath, target)
    }
    await docker(['rm', '-f', '-v', container]).catch(() => {})
    const password = branch.managed?.[m.id]?.password
    if (password === undefined) throw new Error(`no stored password for ${m.id} on ${ref}`)
    await deps.provisionManaged(
      { container, network: branch.network, type: m.type, name: m.name, password, dataDir: dir },
      { publishLoopback: deps.cfg.mode === 'local' },
    )
    if (!wasRunning) await docker(['stop', container]).catch(() => {})
    touched = true
  }
  return touched
}

/** Whether the container already binds this data directory: the mongo/mysql/redis case where an
 *  earlier run finished the copy and the re-create, so there is nothing left to do. */
async function hasMount(container: string, dir: string): Promise<boolean> {
  const out = await inspect(container, '{{range .Mounts}}{{.Source}} {{end}}')
  return out !== null && out.split(' ').some((s) => s === dir || s.startsWith(`${dir}/`))
}

async function inspect(nameOrId: string, format: string): Promise<string | null> {
  try {
    return (await docker(['inspect', '-f', format, nameOrId])).toString().trim()
  } catch {
    return null
  }
}

async function exists(container: string): Promise<boolean> {
  return (await inspect(container, '{{.Id}}')) !== null
}

async function volumeExists(volume: string): Promise<boolean> {
  try { await docker(['volume', 'inspect', volume]); return true } catch { return false }
}

/** Only the DSN's host changes: a re-created container keeps the same files, roles and password. */
export function swapUrlHost(url: string, container: string): string {
  const at = url.lastIndexOf('@')
  if (at === -1) return url
  const rest = url.slice(at + 1)
  const slash = rest.indexOf('/')
  return `${url.slice(0, at + 1)}${container}:5432${slash === -1 ? '' : rest.slice(slash)}`
}

