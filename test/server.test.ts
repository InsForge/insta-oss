// Contract tests: the daemon must serve the exact shapes the stock `insta` CLI consumes.
// Fake adapters — no Docker needed. docker() is mocked (engine only uses it for networks).
import { test, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/docker', () => ({ docker: vi.fn(async () => Buffer.from('')) }))

import { docker as dockerFn } from '../src/docker'
import { buildServer } from '../src/server'
import { Engine } from '../src/engine'
import type { DatabaseAdapter, ComputeAdapter, StorageAdapter, ManagedDbAdapter } from '../src/types'

const calls: string[] = []
const db: DatabaseAdapter = {
  provision: async (ref) => { calls.push(`db.provision:${ref}`); return { url: `pg://${ref}` } },
  // Answers the observability SQL with canned JSON (order matters: metrics SQL also mentions pg_stat_activity).
  query: async (_ref, sql) => {
    calls.push(`db.query:${sql.split(/\s+/).slice(0, 3).join(' ')}`)
    if (sql.includes('drop database "ghost"')) throw new Error('database "ghost" does not exist')
    if (sql.includes('pg_ls_waldir')) return JSON.stringify({
      sizes: { databaseBytes: 9000, tablesBytes: 5000, indexesBytes: 2000, walBytes: 100 },
      tables: [{ name: 'users', liveRows: 10, dataBytes: 4096, indexBytes: 1024, seqScans: 5, idxScans: 7 }],
      vacuum: { totalDeadRows: 2, tables: [{ name: 'users', deadRows: 2, deadPct: 16.7, lastVacuum: null, xidAge: 55 }] },
      unusedIndexes: [{ name: 'idx_dead', table: 'users', sizeBytes: 512, scans: 0 }],
    })
    if (sql.includes('pg_available_extensions')) return JSON.stringify({
      available: [{ name: 'pg_stat_statements' }, { name: 'plpgsql' }, { name: 'vector' }],
      enabled: ['pg_stat_statements', 'plpgsql'],
    })
    if (sql.includes('not datistemplate')) return JSON.stringify([{ name: 'app' }, { name: 'postgres' }])
    if (sql.includes('row_to_json')) return JSON.stringify({ total: 3, active: 1, idle: 2, max: 100, db_size_bytes: 123456, deadlocks: 0, inserted: 10, updated: 5, deleted: 1, blks_hit: 90, blks_read: 10 })
    if (sql.includes('pg_stat_statements')) return JSON.stringify([{ queryId: 'q1', query: 'select 1', calls: 3, totalMs: 9, meanMs: 3, rows: 3 }])
    if (sql.includes('pg_stat_activity')) return JSON.stringify([{ pid: 42, state: 'active', durationMs: 12.5, query: 'select 1' }])
    return ''
  },
  cloneInto: async (s, d) => { calls.push(`db.clone:${s}->${d}`) },
  destroy: async (ref) => { calls.push(`db.destroy:${ref}`) },
}
const compute: ComputeAdapter = {
  supportsVolumes: true,
  deploy: async (ref, o) => {
    calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}:p=${o.port}->${o.hostPort}`)
    if (o.volume) calls.push(`deploy.volume:${ref}:${o.group}:${o.volume.name}`)
    return { url: `http://localhost:${o.hostPort}` }
  },
  destroy: async (ref) => { calls.push(`compute.destroy:${ref}`) },
  start: async (ref, group) => { calls.push(`compute.start:${ref}:${group}`) },
  stop: async (ref, group) => { calls.push(`compute.stop:${ref}:${group}`) },
  suspend: async (ref, group) => { calls.push(`compute.suspend:${ref}:${group}`) },
  state: async () => 'running',
  rename: async (ref, from_, to) => { calls.push(`compute.rename:${ref}:${from_}->${to}`) },
}
const storage: StorageAdapter = {
  provision: async (ref) => { calls.push(`st.provision:${ref}`); return { bucket: `io-${ref}`, env: { BUCKET_NAME: `io-${ref}`, AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_ENDPOINT_URL_S3: 'http://io-minio:9000', AWS_REGION: 'local' } } },
  cloneInto: async (src, dst) => { calls.push(`st.clone:${src}->${dst}`) },
  destroy: async (ref) => { calls.push(`st.destroy:${ref}`) },
  setAccess: async (ref, _network, isPublic) => { calls.push(`st.access:${ref}:${isPublic}`) },
  listBucketObjects: async (env, o) => {
    calls.push(`st.list:${env.BUCKET_NAME}:prefix=${o.prefix ?? ''}:limit=${o.limit}`)
    return { objects: [{ key: 'a.txt', size: 3, lastModified: '2026-08-18T00:00:00Z', etag: '"x"' }], ...(o.cursor ? {} : { nextCursor: 'page2' }) }
  },
  presignObjectGet: async (env, key, disposition) => {
    calls.push(`st.presignGet:${env.BUCKET_NAME}:${key}:${disposition}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}/${key}?sig`, expiresAt: '2026-08-18T00:01:00Z' }
  },
  presignObjectPost: async (env, key, contentType, size) => {
    calls.push(`st.presignPost:${env.BUCKET_NAME}:${key}:${contentType}:${size}`)
    return { url: `http://127.0.0.1:3900/${env.BUCKET_NAME}`, fields: { key, policy: 'p' }, expiresAt: '2026-08-18T00:05:00Z' }
  },
  removeObject: async (env, key) => { calls.push(`st.rm:${env.BUCKET_NAME}:${key}`) },
  removeObjects: async (env, keys) => { calls.push(`st.rmN:${env.BUCKET_NAME}:${keys.join(',')}`); return { deleted: keys.length, failed: [] } },
}
const managed: ManagedDbAdapter = {
  provision: async (ref, _network, type, name) => { calls.push(`md.provision:${ref}:${type}:${name}`) },
  destroy: async (ref, type, name) => { calls.push(`md.destroy:${ref}:${type}:${name}`) },
  rename: async (ref, type, from_, to) => { calls.push(`md.rename:${ref}:${type}:${from_}->${to}`) },
}

let app: ReturnType<typeof buildServer>
beforeEach(() => {
  process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-')), 'state.json')
  calls.length = 0
  app = buildServer(new Engine(db, compute, storage, managed))
})

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload })
const get = (url: string) => app.inject({ method: 'GET', url })
const put = (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, payload })
const patch = (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url, payload })
const del_ = (url: string) => app.inject({ method: 'DELETE', url })

async function createProject(name = 'demo'): Promise<string> {
  const r = await post('/orgs/local/projects', { name })
  return r.json().project.id
}

test('me/orgs stubs satisfy the CLI (orgs[0].id drives project create)', async () => {
  expect((await get('/me')).json().user.id).toBe('local')
  const orgs = (await get('/orgs')).json().orgs
  expect(orgs).toHaveLength(1)
  expect(orgs[0].id).toBe('local')
})

test('project create returns {project, defaultBranch, resources[].kind} and provisions main', async () => {
  const r = await post('/orgs/local/projects', { name: 'demo' })
  expect(r.statusCode).toBe(201)
  const body = r.json()
  expect(body.project.name).toBe('demo')
  expect(body.defaultBranch.name).toBe('main')
  expect(body.resources.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['postgres', 'storage', 'compute']))
  expect(calls).toContain('db.provision:demo-main')
  expect(calls).toContain('st.provision:demo-main')
})

test('branch create clones data + redeploys apps; branches list has is_default/status', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const r = await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(r.statusCode).toBe(201)
  expect(r.json().branch.name).toBe('feat')
  expect(calls).toContain('db.clone:demo-main->demo-feat')
  expect(calls).toContain('st.clone:demo-main->demo-feat') // storage branching = bucket copy
  // redeploy wired to the CLONE's bucket; SAME listen port (3000), shifted host mapping (4000)
  expect(calls).toContain('deploy:demo-feat:default:app:1:s3=io-demo-feat:p=3000->4000')

  const branches = (await get(`/projects/${id}/branches`)).json().branches
  expect(branches.map((b: { name: string }) => b.name).sort()).toEqual(['feat', 'main'])
  expect(branches.find((b: { name: string }) => b.name === 'main').is_default).toBe(true)

  const feat = branches.find((b: { name: string }) => b.name === 'feat')
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/branches/${feat.id}` })
  expect(del.statusCode).toBe(200)
  expect(del.json()).toEqual({})
})

test('secrets returns the branch bundle (seam) and is gateable', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/secrets?branch=main`)
  expect(r.statusCode).toBe(200)
  expect(r.json().secrets.DATABASE_URL).toBe('pg://demo-main')
  expect(r.json().secrets.BUCKET_NAME).toBe('io-demo-main') // S3 bundle rides the same seam

  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/secrets.read`, payload: { decision: 'approve' } })
  const gatedRes = await get(`/projects/${id}/secrets?branch=main`)
  expect(gatedRes.statusCode).toBe(202)
  expect(gatedRes.json()).toMatchObject({ status: 'approval_required', action: 'secrets.read' })
})

test('project.delete defaults to approve: 202 → approve → retry succeeds → grant consumed', async () => {
  const id = await createProject()
  const first = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  expect(first.statusCode).toBe(202)
  const approvalId = first.json().approvalId

  const approvals = (await get(`/projects/${id}/approvals?status=pending`)).json().approvals
  expect(approvals.map((a: { id: string }) => a.id)).toContain(approvalId)

  const ap = await post(`/projects/${id}/approvals/${approvalId}/approve`)
  expect(ap.statusCode).toBe(200)
  expect(ap.json().approval.action).toBe('project.delete')

  const second = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  expect(second.statusCode).toBe(200) // consumed the grant
  expect(second.json()).toEqual({})
  expect((await get('/orgs/local/projects')).json().projects).toHaveLength(0)
})

test('approve --always flips the policy to allow (no more prompts)', async () => {
  const id = await createProject()
  const first = await app.inject({ method: 'DELETE', url: `/projects/${id}` })
  await post(`/projects/${id}/approvals/${first.json().approvalId}/approve`, { always: true })
  expect((await get(`/projects/${id}/policy`)).json().policy['project.delete']).toBe('allow')
})

test('policy deny blocks with 403', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/deploy`, payload: { decision: 'deny' } })
  const r = await post(`/projects/${id}/deploy`, { image: 'x', branch: 'main' })
  expect(r.statusCode).toBe(403)
})

test('events: resource timeline + agent ingest with dedup', async () => {
  const id = await createProject()
  await post(`/projects/${id}/events`, { kind: 'cred.leak', source: 'agent', dedup_key: 'k1', payload: { sev: 'high' } })
  await post(`/projects/${id}/events`, { kind: 'cred.leak', source: 'agent', dedup_key: 'k1' }) // duplicate
  const events = (await get(`/projects/${id}/events`)).json().events
  expect(events.filter((e: { kind: string }) => e.kind === 'cred.leak')).toHaveLength(1)
  expect(events.map((e: { kind: string }) => e.kind)).toContain('project.created')
  expect(events[0]).toHaveProperty('created_at') // CLI prints e.created_at
})

test('manifest detail: project/branches/resources with ref.url', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'backend' })
  const d = (await get(`/projects/${id}`)).json()
  expect(d.project.org_id).toBe('local')
  const kinds = d.resources.map((r: { kind: string }) => r.kind)
  expect(kinds).toEqual(expect.arrayContaining(['postgres', 'storage', 'compute']))
  expect(d.resources.every((r: { ref: { url?: string; bucket?: string } }) => r.ref.url || r.ref.bucket)).toBe(true)
})

test('cloud-only surfaces (billing/usage/tokens) return 501 with a clear message', async () => {
  for (const url of ['/tokens', '/orgs/local/billing', '/projects/x/usage']) {
    const r = await get(url)
    expect(r.statusCode).toBe(501)
    expect(r.json().error).toMatch(/cloud-only/)
  }
  // metrics/logs are real (docker-backed) now — unknown project is a 404, not a stub
  expect((await get('/projects/x/metrics')).statusCode).toBe(404)
  expect((await get('/projects/x/logs')).statusCode).toBe(404)
})

test('every cloud-only or not-yet route answers a clean 501, never a bare 404', async () => {
  const cloudOnly: Array<[string, string]> = [
    ['GET', '/projects/x/usage/daily'], ['GET', '/projects/x/utilisation'],
    ['GET', '/orgs/local/members'], ['PUT', '/orgs/local/members/u1'], ['DELETE', '/orgs/local/members/u1'],
    ['POST', '/orgs/local/invitations'], ['GET', '/orgs/local/invitations'], ['DELETE', '/orgs/local/invitations/i1'],
    ['POST', '/invitations/accept'],
    ['POST', '/tokens'], ['DELETE', '/tokens/t1'],
    ['GET', '/images/inspect'],
    ['GET', '/projects/x/services/cp-x/limits'], ['PUT', '/projects/x/services/cp-x/limits'],
    ['PUT', '/projects/x/services/cp-x/always-on'], ['PATCH', '/projects/x/services/cp-x'],
    ['POST', '/projects/x/compute/domain'], ['GET', '/projects/x/compute/domain'], ['DELETE', '/projects/x/compute/domain'],
    ['POST', '/projects/x/deploy-token'],
    ['POST', '/projects/x/backups'], ['GET', '/projects/x/backups'], ['DELETE', '/projects/x/backups/b1'], ['POST', '/projects/x/backups/b1/restore'],
    ['GET', '/orgs/local/billing/cycle'], ['GET', '/orgs/local/billing/overview'],
    ['POST', '/orgs/local/billing/checkout'], ['POST', '/orgs/local/billing/portal'],
  ]
  for (const [method, url] of cloudOnly) {
    const r = await app.inject({ method: method as 'GET', url })
    expect(r.statusCode, `${method} ${url}`).toBe(501)
    expect(r.json().error, `${method} ${url}`).toMatch(/cloud-only/)
  }
  const notYetRoutes: Array<[string, string]> = [
    ['GET', '/projects/x/deploy-events'],
  ]
  for (const [method, url] of notYetRoutes) {
    const r = await app.inject({ method: method as 'GET', url })
    expect(r.statusCode, `${method} ${url}`).toBe(501)
    expect(r.json().error, `${method} ${url}`).toMatch(/not implemented by insta-oss yet/)
  }
})

test('regions returns the single local region in the CLI shape', async () => {
  const r = await get('/regions')
  expect(r.statusCode).toBe(200)
  expect(r.json().regions).toEqual([{ slug: 'local', label: 'Local (this machine)' }])
})

// ---- services-model parity (Phase 1.5) ----

test('services list: fixed postgres+storage + compute groups; CLI shape', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  const types = services.map((s: { type: string }) => s.type)
  expect(types).toEqual(expect.arrayContaining(['postgres', 'storage', 'compute']))
  const api = services.find((s: { name: string }) => s.name === 'api')
  expect(api).toMatchObject({ id: 'cp-api', type: 'compute', status: 'ready', machine_count: 1 })
})

test('services add compute registers a group; duplicates 409; pg/storage add is idempotent (contract parity)', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'cp-worker', type: 'compute', name: 'worker' })
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })).statusCode).toBe(409)
  // the same `services add postgres|storage` onboarding script must run on both targets
  const pg = await post(`/projects/${id}/services`, { type: 'postgres', name: 'db2' })
  expect(pg.statusCode).toBe(201)
  expect(pg.json().service).toMatchObject({ id: 'pg-db', type: 'postgres', name: 'db' })
  const st = await post(`/projects/${id}/services`, { type: 'storage', name: 'blobs' })
  expect(st.statusCode).toBe(201)
  expect(st.json().service).toMatchObject({ id: 'st-store', type: 'storage', name: 'store', public: false })
  const publicSt = await post(`/projects/${id}/services`, { type: 'storage', name: 'blobs', public: true })
  expect(publicSt.statusCode).toBe(201)
  expect(publicSt.json().service).toMatchObject({ id: 'st-store', type: 'storage', name: 'store', public: true })
  expect((await post(`/projects/${id}/services`, { type: 'queue', name: 'q' })).statusCode).toBe(400)
})

test('services remove compute destroys the group; pg/storage remove → 501', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-api` })
  expect(del.statusCode).toBe(200)
  expect(del.json()).toEqual({})
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.some((s: { name: string }) => s.name === 'api')).toBe(false)
  expect((await app.inject({ method: 'DELETE', url: `/projects/${id}/services/pg-db` })).statusCode).toBe(501)
})

// ---- user-defined secrets (insta secrets set/unset) ----

test('secrets set/unset: project-wide + branch override, merged into the bundle + deploy env', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/MY_FLAG`, payload: { value: 'proj' } })).statusCode).toBe(200)
  await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/MY_FLAG`, payload: { value: 'feat-only', branch: 'feat' } })

  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.MY_FLAG).toBe('proj')
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.MY_FLAG).toBe('feat-only')

  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  expect(calls.some((c) => c.includes('deploy:demo-main'))).toBe(true) // env carried via adapter (see fake)

  await app.inject({ method: 'DELETE', url: `/projects/${id}/secrets/MY_FLAG?branch=feat` })
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.MY_FLAG).toBe('proj') // falls back to project-wide
})

test('secrets set rejects reserved names and is gateable via secrets.write', async () => {
  const id = await createProject()
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/DATABASE_URL`, payload: { value: 'x' } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/AWS_SECRET_ACCESS_KEY`, payload: { value: 'x' } })).statusCode).toBe(400)
  await app.inject({ method: 'PUT', url: `/projects/${id}/policy/secrets.write`, payload: { decision: 'approve' } })
  expect((await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/OK_NAME`, payload: { value: 'x' } })).statusCode).toBe(202)
})

test('branch create clones the parent branch-scoped user secrets', async () => {
  const id = await createProject()
  await app.inject({ method: 'PUT', url: `/projects/${id}/secrets/ONLY_MAIN`, payload: { value: 'v', branch: 'main' } })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/secrets?branch=feat`)).json().secrets.ONLY_MAIN).toBe('v')
})

test('org-level usage returns the friendly cloud-only 501 (CLI >=0.0.4 default path)', async () => {
  const r = await get('/orgs/local/usage')
  expect(r.statusCode).toBe(501)
  expect(r.json().error).toMatch(/cloud-only/)
})

test('redeploying to a branch keeps its allocated host port (regression: collided with main)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' }) // feat allocated 3000->4000
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'feat', port: 3000 }) // redeploy new image
  expect(calls).toContain('deploy:demo-feat:default:app:2:s3=io-demo-feat:p=3000->4000') // NOT ->3000
})

// ---- dashboard additions ----

test('services carry dashboard fields (runtime/endpoint/updated_at) and are branch-aware', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })

  const main = (await get(`/projects/${id}/services`)).json().services // defaults to the default branch
  const db = main.find((s: { id: string }) => s.id === 'pg-db')
  expect(db.endpoint).toBe('io-demo-main-pg:5432')
  expect(db.runtime).toBe('stopped') // fake docker ps lists nothing
  const cp = main.find((s: { id: string }) => s.id === 'cp-default')
  expect(cp.endpoint).toBe('localhost:3000')
  expect(cp.updated_at).toBeTruthy()
  expect(cp.status).toBe('ready') // CLI-printed field untouched

  const feat = (await get(`/projects/${id}/services?branch=feat`)).json().services
  expect(feat.find((s: { id: string }) => s.id === 'cp-default').endpoint).toBe('localhost:4000')
  expect((await get(`/projects/${id}/services?branch=nope`)).statusCode).toBe(404)
})

test('registered-but-undeployed compute reports runtime none', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.find((s: { id: string }) => s.id === 'cp-worker').runtime).toBe('none')
})

test('dashboard serving: SPA fallback for non-API GETs; API routes always win', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dist = mkdtempSync(join(tmpdir(), 'io-ui-'))
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html>dash</html>')
  process.env.INSTA_OSS_UI_DIST = dist
  const ui = buildServer(new Engine(db, compute, storage, managed))
  delete process.env.INSTA_OSS_UI_DIST

  expect((await ui.inject({ method: 'GET', url: '/' })).body).toContain('dash')
  expect((await ui.inject({ method: 'GET', url: '/p/some-project/main/services' })).body).toContain('dash')
  const api = await ui.inject({ method: 'GET', url: '/projects/nope' })
  expect(api.statusCode).toBe(404)
  expect(api.json().error).toBeTruthy() // JSON error, not the SPA shell
})

test('dashboard serving: without a build, / explains how to get the UI', async () => {
  process.env.INSTA_OSS_UI_DIST = join(tmpdir(), 'io-ui-definitely-missing')
  const bare = buildServer(new Engine(db, compute, storage, managed))
  delete process.env.INSTA_OSS_UI_DIST
  const r = await bare.inject({ method: 'GET', url: '/' })
  expect(r.body).toContain('build:ui')
})

// ---- contract parity: secrets tree, service secrets, merge, lifecycle, access ----

test('secrets tree: minted creds under their service; user secrets grouped by binding', async () => {
  const id = await createProject()
  await put(`/projects/${id}/secrets/GLOBAL_KEY`, { value: 'v' })
  await put(`/projects/${id}/secrets/BRANCH_KEY`, { value: 'v', branch: 'main' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  expect(tree.projectWide).toEqual(['GLOBAL_KEY'])
  const main = tree.branches.find((b: { name: string }) => b.name === 'main')
  expect(main.isDefault).toBe(true)
  expect(main.unbound).toEqual(['BRANCH_KEY'])
  expect(main.services.find((s: { type: string }) => s.type === 'postgres').secrets).toContain('DATABASE_URL')
  expect(main.services.find((s: { type: string }) => s.type === 'storage').secrets).toContain('BUCKET_NAME')
  expect(main.services.find((s: { name: string }) => s.name === 'api').secrets).toEqual(['API_KEY'])
})

test('secrets tree is gated by secrets.read', async () => {
  const id = await createProject()
  await put(`/projects/${id}/policy/secrets.read`, { decision: 'approve' })
  expect((await get(`/projects/${id}/secrets/tree`)).statusCode).toBe(202)
})

test('secret service binding requires a branch and an existing service', async () => {
  const id = await createProject()
  expect((await put(`/projects/${id}/secrets/X`, { value: 'v', service: 'compute/api' })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/secrets/X`, { value: 'v', branch: 'main', service: 'compute/nope' })).statusCode).toBe(400)
})

test('service secrets endpoint returns names only, per service', async () => {
  const id = await createProject()
  expect((await get(`/projects/${id}/services/pg-db/secrets`)).json().secrets).toEqual(['DATABASE_URL'])
  expect((await get(`/projects/${id}/services/st-store/secrets`)).json().secrets).toContain('AWS_ACCESS_KEY_ID')
  expect((await get(`/projects/${id}/services/cp-nope/secrets`)).statusCode).toBe(404)
})

test('a service-bound secret is injected only into its own compute group', async () => {
  const envs: Record<string, string[]> = {}
  const localCompute: ComputeAdapter = {
    deploy: async (_r, o) => { envs[o.group] = Object.keys(o.envVars); return { url: `http://localhost:${o.hostPort ?? o.port}` } },
    destroy: async () => {},
  }
  const local = buildServer(new Engine(db, localCompute, storage, managed))
  const lpost = (url: string, payload?: unknown) => local.inject({ method: 'POST', url, payload })
  const id = (await lpost('/orgs/local/projects', { name: 'bind-demo' })).json().project.id
  await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api' })
  await lpost(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  await local.inject({ method: 'PUT', url: `/projects/${id}/secrets/ONLY_API`, payload: { value: 'v', branch: 'main', service: 'compute/api' } })
  await lpost(`/projects/${id}/deploy`, { image: 'a:1', branch: 'main', group: 'api' })
  await lpost(`/projects/${id}/deploy`, { image: 'a:1', branch: 'main', group: 'worker' })
  expect(envs.api).toContain('ONLY_API')
  expect(envs.worker).not.toContain('ONLY_API')
})

test('branch merge is structural + additive: missing compute groups materialize on the target', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await post(`/projects/${id}/deploy`, { image: 'worker:1', branch: 'feat', port: 3100, group: 'worker' })
  const r = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(r.statusCode).toBe(200)
  expect(r.json().created).toEqual([{ type: 'compute', name: 'worker' }])
  expect(r.json().skipped).toEqual(expect.arrayContaining([
    { type: 'postgres', name: 'db', reason: 'exists' },
    { type: 'storage', name: 'store', reason: 'exists' },
    { type: 'compute', name: 'default', reason: 'exists' },
  ]))
  // the new group runs against MAIN's own resources — no data or creds carried from feat
  expect(calls.some((c) => c.startsWith('deploy:demo-main:worker:worker:1:s3=io-demo-main'))).toBe(true)
  // re-merge is idempotent
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })).json().created).toEqual([])
  // errors: same branch / unknown source → 400; unknown target → 404
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'main' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/branches/main/merge`, { from: 'nope' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/branches/nope/merge`, { from: 'feat' })).statusCode).toBe(404)
})

test('compute lifecycle: stop sets desired intent; state reports desired vs live', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const r = await post(`/projects/${id}/services/cp-default/stop`)
  expect(r.statusCode).toBe(200)
  expect(r.json().service.desired_state).toBe('stopped')
  expect(r.json().state).toBe('running') // fake adapter always reports running
  expect(calls).toContain('compute.stop:demo-main:default')
  const st = (await get(`/projects/${id}/services/cp-default/state`)).json()
  expect(st).toEqual({ desiredState: 'stopped', state: 'running' })
  await post(`/projects/${id}/services/cp-default/start`)
  expect((await get(`/projects/${id}/services/cp-default/state`)).json().desiredState).toBe('running')
  // lifecycle is compute-only; unknown services 404
  expect((await post(`/projects/${id}/services/pg-db/stop`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/cp-nope/state`)).statusCode).toBe(404)
})

test('compute restart REDEPLOYS the recorded image (fresh env), and refuses a stopped service', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  calls.length = 0
  const r = await post(`/projects/${id}/services/cp-default/restart`)
  expect(r.statusCode).toBe(200)
  // A redeploy of the SAME image on the SAME host mapping, not an adapter start/stop: env is
  // assembled at deploy time, so this is the only path that carries a changed secret in.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:default:app:1:'))).toBe(true)
  expect(calls.some((c) => c.startsWith('compute.start:') || c.startsWith('compute.stop:'))).toBe(false)
  expect(r.json().state).toBe('running')

  // Stopped is a persistent intent — a restart must not quietly bring it back.
  await post(`/projects/${id}/services/cp-default/stop`)
  calls.length = 0
  const stopped = await post(`/projects/${id}/services/cp-default/restart`)
  expect(stopped.statusCode).toBe(400)
  expect(stopped.json().error).toMatch(/insta compute start/)
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  // compute-only, and a never-deployed service has nothing to re-run
  expect((await post(`/projects/${id}/services/pg-db/restart`)).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/cp-nope/restart`)).statusCode).toBe(404)
})

// Restart reaches engine.deploy(), which re-mints DATABASE_URL, the S3 bundle and every bound
// secret into a new container — so it stands behind the same policy as `POST /deploy`, exactly as
// the platform gates it. An ungated door here would mean a `deploy: deny` an operator set is
// simply not on.
test('compute restart is gated on `deploy`, like every other door that redeploys', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  await put(`/projects/${id}/policy/deploy`, { decision: 'deny' })
  calls.length = 0
  const denied = await post(`/projects/${id}/services/cp-default/restart`)
  expect(denied.statusCode).toBe(403)
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  await put(`/projects/${id}/policy/deploy`, { decision: 'approve' })
  const relayed = await post(`/projects/${id}/services/cp-default/restart`)
  expect(relayed.statusCode).toBe(202)
  expect(relayed.json().approvalId).toBeTruthy()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)

  // ...and stop/start stay ungated under the same policy, so a wedged container is still cyclable.
  expect((await post(`/projects/${id}/services/cp-default/stop`)).statusCode).toBe(200)
  expect((await post(`/projects/${id}/services/cp-default/start`)).statusCode).toBe(200)
})

test('storage access mode flips public/private; scale/upgrade stay clean 501s', async () => {
  const id = await createProject()
  const r = await put(`/projects/${id}/services/st-store/access`, { public: true })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'st-store', public: true })
  expect(calls).toContain('st.access:demo-main:true')
  expect((await get(`/projects/${id}/services`)).json().services.find((s: { id: string }) => s.id === 'st-store').public).toBe(true)
  expect((await put(`/projects/${id}/services/pg-db/access`, { public: true })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/services/st-store/access`, {})).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/cp-x/scale`, { machineCount: 2 })).statusCode).toBe(501)
  expect((await post(`/projects/${id}/services/cp-x/upgrade`, { spec: '2vcpu-2gb' })).statusCode).toBe(501)
})

// ---- observability: logs, metrics, operations, database ----

test('logs endpoint tails containers with the cloud LogsResult shape (db works locally too)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) =>
    Buffer.from(args[0] === 'logs' ? '2026-07-22T01:00:00.000Z hello\nno-timestamp-line\n' : ''))
  const r = (await get(`/projects/${id}/logs?component=compute&branch=main&limit=50`)).json()
  expect(r.source).toBe('docker-logs')
  expect(r.lines.find((l: { ts: string }) => l.ts)).toMatchObject({ ts: '2026-07-22T01:00:00.000Z', message: 'hello', instance: 'io-demo-main-app-default' })
  expect(r.lines.find((l: { ts: string }) => !l.ts)).toMatchObject({ message: 'no-timestamp-line' })
  const dbLogs = (await get(`/projects/${id}/logs?component=db`)).json()
  expect(dbLogs.lines.length).toBeGreaterThan(0) // the cloud returns a provider note for db; locally it is a real container
  vi.mocked(dockerFn).mockImplementation(async () => Buffer.from(''))
})

test('metrics endpoint returns docker-stats series (cpu %, memory bytes)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  vi.mocked(dockerFn).mockImplementation(async (args: string[]) =>
    Buffer.from(args[0] === 'stats' ? '{"Name":"io-demo-main-app-default","CPUPerc":"1.25%","MemUsage":"12MiB / 4GiB"}\n' : ''))
  const r = (await get(`/projects/${id}/metrics?component=compute&branch=main`)).json()
  expect(r.source).toBe('docker-stats')
  expect(r.series.find((s: { name: string }) => s.name === 'cpu').points[0][1]).toBe(1.25)
  expect(r.series.find((s: { name: string }) => s.name === 'memory').points[0][1]).toBe(12 * 1024 * 1024)
  vi.mocked(dockerFn).mockImplementation(async () => Buffer.from(''))
})

test('operations lists the resource timeline newest-first (control-plane shape)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })
  const { operations } = (await get(`/projects/${id}/operations?limit=10`)).json()
  expect(operations[0]).toMatchObject({ action: 'deploy', status: 'finished' })
  expect(operations.map((o: { action: string }) => o.action)).toContain('project.created')
})

test('database metrics/activity/query-stats run SQL with the cloud shapes', async () => {
  const id = await createProject()
  const m = (await get(`/projects/${id}/database/metrics`)).json()
  expect(m).toMatchObject({ connections: { active: 1, idle: 2, total: 3, max: 100 }, dbSizeBytes: 123456 })
  expect(m.cacheHitRatio).toBeCloseTo(0.9)
  const a = (await get(`/projects/${id}/database/activity`)).json()
  expect(a.queries[0]).toMatchObject({ pid: 42, state: 'active' })
  const qs = (await get(`/projects/${id}/database/query-stats?sort=calls&limit=5`)).json()
  expect(qs).toMatchObject({ extensionReady: true })
  expect(qs.stats[0]).toMatchObject({ queryId: 'q1', calls: 3 })
  expect((await get('/projects/nope/database/metrics')).statusCode).toBe(404)
})

test('service rename: re-keys group, containers, bindings; conflicts 409; pg/storage 501', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  await put(`/projects/${id}/secrets/API_KEY`, { value: 'v', branch: 'main', service: 'compute/api' })
  const r = await post(`/projects/${id}/services/cp-api/rename`, { name: 'gateway' })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'cp-gateway', type: 'compute', name: 'gateway' })
  expect(calls).toContain('compute.rename:demo-main:api->gateway')
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.map((s: { name: string }) => s.name)).toContain('gateway')
  expect(services.map((s: { name: string }) => s.name)).not.toContain('api')
  // the secret binding followed the rename
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  expect(tree.branches[0].services.find((s: { name: string }) => s.name === 'gateway').secrets).toEqual(['API_KEY'])
  // conflicts, validation, fixed pair, unknown service
  await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  expect((await post(`/projects/${id}/services/cp-worker/rename`, { name: 'gateway' })).statusCode).toBe(409)
  expect((await post(`/projects/${id}/services/cp-gateway/rename`, { name: 'Bad_Name' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/pg-db/rename`, { name: 'primary' })).statusCode).toBe(501)
  expect((await post(`/projects/${id}/services/cp-nope/rename`, { name: 'x' })).statusCode).toBe(404)
})

// ---- volumes + database settings (tier-caps contract parity, platform #166–169) ----

test('compute volume: attach at create, mounted at /data on deploy, GET/PUT mirror the cloud shapes', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'cp-api', type: 'compute', name: 'api', volume_gib: 5 })

  // services list carries the platform Service.volume_gib field (null when no volume)
  await post(`/projects/${id}/services`, { type: 'compute', name: 'plain' })
  const { services } = (await get(`/projects/${id}/services`)).json()
  expect(services.find((s: { id: string }) => s.id === 'cp-api').volume_gib).toBe(5)
  expect(services.find((s: { id: string }) => s.id === 'cp-plain').volume_gib).toBeNull()

  // deploy mounts a per-branch named volume at /data
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  expect(calls.some((c) => c.startsWith('deploy.volume:demo-main:api:io-demo-main-data-'))).toBe(true)

  // GET …/volume: {volume:{sizeGib,mountPath}|null, cap:{volumeGib}}
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json())
    .toEqual({ volume: { sizeGib: 5, mountPath: '/data' }, cap: { volumeGib: 100 } })
  expect((await get(`/projects/${id}/services/cp-plain/volume`)).json())
    .toEqual({ volume: null, cap: { volumeGib: 100 } })

  // PUT …/volume grows (advisory locally); response = {service, volume, cap}
  const grow = await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 7 })
  expect(grow.statusCode).toBe(200)
  expect(grow.json()).toMatchObject({
    service: { id: 'cp-api', volume_gib: 7 },
    volume: { sizeGib: 7, mountPath: '/data' },
    cap: { volumeGib: 100 },
  })
  // no-op re-submit succeeds (a settings form saved unmoved must not fail)
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 7 })).statusCode).toBe(200)
})

test('compute volume rules: grow-only 400, cap + validation, compute-only', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  const shrink = await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 3 })
  expect(shrink.statusCode).toBe(400)
  expect(shrink.json().error).toMatch(/can only grow/)
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 101 })).statusCode).toBe(400) // over cap
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1.5 })).statusCode).toBe(400) // whole Gi only
  expect((await put(`/projects/${id}/services/cp-api/volume`, {})).statusCode).toBe(400)
  expect((await put(`/projects/${id}/services/pg-db/volume`, { sizeGib: 20 })).statusCode).toBe(400) // compute only
  expect((await get(`/projects/${id}/services/pg-db/volume`)).statusCode).toBe(400)
  expect((await get(`/projects/${id}/services/cp-nope/volume`)).statusCode).toBe(404)
  expect((await get(`/projects/nope/services/cp-api/volume`)).statusCode).toBe(404)
  // create-time validation
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'v2', volumeGib: 0 })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'v2', volumeGib: 101 })).statusCode).toBe(400)
})

test('attach-after-create (platform #185 parity): PUT on a volumeless service attaches, attached:true, next deploy mounts', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'later' })
  expect((await get(`/projects/${id}/services/cp-later/volume`)).json().volume).toBeNull()
  const attach = await put(`/projects/${id}/services/cp-later/volume`, { sizeGib: 2 })
  expect(attach.statusCode).toBe(200)
  expect(attach.json()).toMatchObject({ attached: true, volume: { sizeGib: 2, mountPath: '/data' } })
  // attach validates like create: cap + whole-Gi still apply to a FIRST size
  await post(`/projects/${id}/services`, { type: 'compute', name: 'later2' })
  expect((await put(`/projects/${id}/services/cp-later2/volume`, { sizeGib: 101 })).statusCode).toBe(400)
  // the disk materializes on the next deploy — mounted by volume id, cloud-identical flow
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'later' })
  expect(calls.some((c) => c.startsWith('deploy.volume:demo-main:later:io-demo-main-data-'))).toBe(true)
  // from here it is an ordinary volume: a grow is a grow, not another attach
  const grow = await put(`/projects/${id}/services/cp-later/volume`, { sizeGib: 3 })
  expect(grow.statusCode).toBe(200)
  expect(grow.json().attached).toBeUndefined()
})

test('volume delete (cloud 2026-08-08 contract): eager rebuild without the mount, read-back null, re-attach = new attach', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  calls.length = 0
  const del = await del_(`/projects/${id}/services/cp-api/volume`)
  expect(del.statusCode).toBe(200)
  expect(del.json()).toMatchObject({ removed: true, volume: null, service: { volume_gib: null } })
  // EAGER: the deployed branch was rebuilt WITHOUT the mount right away — no deploy.volume call.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy.volume:'))).toBe(false)
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json().volume).toBeNull()
  // double delete = the cloud's 404, not a silent no-op
  const again = await del_(`/projects/${id}/services/cp-api/volume`)
  expect(again.statusCode).toBe(404)
  expect(again.json().error).toMatch(/no volume/)
  // the door is reopened: re-attach works as an ordinary NEW attach
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1 })).json()).toMatchObject({ attached: true })
})

test('volume delete sweeps EVERY deployed branch: both rebuilt without the mount, both volumes cleaned', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 2 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' }) // branch inherits the deployed app
  calls.length = 0
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  // The per-branch loop hit BOTH branches, and neither rebuild carried the mount.
  expect(calls.some((c) => c.startsWith('deploy:demo-main:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy:demo-feat:api'))).toBe(true)
  expect(calls.some((c) => c.startsWith('deploy.volume:'))).toBe(false)
  expect((await get(`/projects/${id}/services/cp-api/volume`)).json().volume).toBeNull()
})

test('volume delete preserves lifecycle intent EXACTLY: suspended stays suspended, stopped stays stopped', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 2 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  // Suspended service (allowed with a volume here, unlike the cloud) — delete must land back on
  // 'suspend', not rewrite desiredState to 'stopped' (r2d2 finding).
  await post(`/projects/${id}/services/cp-api/suspend`)
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  // desiredState is the recorded intent (the fake adapter's live state is a constant), and intent
  // is exactly what the regression lost.
  expect((await get(`/projects/${id}/services/cp-api/state`)).json()).toMatchObject({ desiredState: 'suspended' })
  expect(calls.some((c) => c.startsWith('compute.suspend:demo-main:api'))).toBe(true)
  // And the stopped case stays stopped.
  expect((await put(`/projects/${id}/services/cp-api/volume`, { sizeGib: 1 })).statusCode).toBe(200)
  await post(`/projects/${id}/services/cp-api/stop`)
  expect((await del_(`/projects/${id}/services/cp-api/volume`)).statusCode).toBe(200)
  expect((await get(`/projects/${id}/services/cp-api/state`)).json()).toMatchObject({ desiredState: 'stopped' })
})

test('compute volume survives a service rename (record follows, docker volume name is id-keyed)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const volName = calls.find((c) => c.startsWith('deploy.volume:'))!.split(':')[3]
  await post(`/projects/${id}/services/cp-api/rename`, { name: 'gateway' })
  expect((await get(`/projects/${id}/services/cp-gateway/volume`)).json().volume).toEqual({ sizeGib: 5, mountPath: '/data' })
  calls.length = 0
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'main', port: 3000, group: 'gateway' })
  expect(calls).toContain(`deploy.volume:demo-main:gateway:${volName}`) // same volume, data kept
})

test('an adapter without volume support rejects volume-carrying services with a clear error', async () => {
  const noVol: ComputeAdapter = { deploy: async () => ({ url: 'http://x' }), destroy: async () => {} }
  const local = buildServer(new Engine(db, noVol, storage, managed))
  const lpost = (url: string, payload?: unknown) => local.inject({ method: 'POST', url, payload })
  const id = (await lpost('/orgs/local/projects', { name: 'novol' })).json().project.id
  const r = await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api', volumeGib: 5 })
  expect(r.statusCode).toBe(400)
  expect(r.json().error).toMatch(/not supported by this compute adapter/)
  expect((await lpost(`/projects/${id}/services`, { type: 'compute', name: 'api' })).statusCode).toBe(201) // no volume: fine
})

test('database instance read + settings PATCH: volumeSize parity (grow-only, advisory locally)', async () => {
  const id = await createProject()
  const info = (await get(`/projects/${id}/database/instance`)).json()
  expect(info).toMatchObject({ name: 'db', volumeSize: '10Gi', volumeGib: 10, cap: { volumeGib: 100 } })
  expect(info.storageSize).toBe('10Gi') // deprecated alias still mirrored, like the platform

  const up = await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })
  expect(up.statusCode).toBe(200)
  expect(up.json()).toMatchObject({ volumeSize: '20Gi', volumeGib: 20 })
  expect((await get(`/projects/${id}/database/instance`)).json().volumeGib).toBe(20)

  // grow-only + whole-Gi validation + cap; no-op re-submit succeeds
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })).statusCode).toBe(200)
  const shrink = await patch(`/projects/${id}/database/settings`, { volumeSize: '5Gi' })
  expect(shrink.statusCode).toBe(400)
  expect(shrink.json().error).toMatch(/can only grow/)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '5G' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '500Mi' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/settings`, { volumeSize: '101Gi' })).statusCode).toBe(400)
  // deprecated alias accepted; unrelated cloud-lever settings are accepted and ignored
  expect((await patch(`/projects/${id}/database/settings`, { storageSize: '30Gi' })).statusCode).toBe(200)
  expect((await patch(`/projects/${id}/database/settings`, { scaleToZero: true, idleTimeout: 60 })).statusCode).toBe(200)
  expect((await patch(`/projects/nope/database/settings`, { volumeSize: '20Gi' })).statusCode).toBe(404)
  expect((await get(`/projects/${id}/database/instance?branch=nope`)).statusCode).toBe(404)
})

test('database volumeSize is per-branch and the setting clones with the branch', async () => {
  const id = await createProject()
  await patch(`/projects/${id}/database/settings`, { volumeSize: '20Gi' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/database/instance?branch=feat`)).json().volumeGib).toBe(20) // inherited
  await patch(`/projects/${id}/database/settings?branch=feat`, { volumeSize: '40Gi' })
  expect((await get(`/projects/${id}/database/instance?branch=feat`)).json().volumeGib).toBe(40)
  expect((await get(`/projects/${id}/database/instance`)).json().volumeGib).toBe(20) // main untouched
})

// ---- managed databases: redis | mysql | mongodb (cloud parity, platform #235/#236) ----

test('managed db add: 201 row shape the CLI renders; per-branch container; still 400 on junk types', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  expect(r.statusCode).toBe(201)
  expect(r.json().service).toMatchObject({ id: 'rd-cache', type: 'redis', name: 'cache', status: 'ready', port: 6379, volume_gib: 1 })
  expect(calls).toContain('md.provision:demo-main:redis:cache')

  const services = (await get(`/projects/${id}/services`)).json().services
  const row = services.find((s: { id: string }) => s.id === 'rd-cache')
  expect(row).toMatchObject({ type: 'redis', port: 6379, volume_gib: 1, endpoint: 'io-demo-main-rd-cache:6379' })

  expect((await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })).statusCode).toBe(409)
  expect((await post(`/projects/${id}/services`, { type: 'kafka', name: 'x' })).statusCode).toBe(400)
})

test('managed db add is gated (service.add): 202 approval flow', async () => {
  const id = await createProject()
  await put(`/projects/${id}/policy/service.add`, { decision: 'approve' })
  const r = await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })
  expect(r.statusCode).toBe(202)
  expect(r.json()).toMatchObject({ status: 'approval_required', action: 'service.add' })
})

test('managed db secrets: suffixed bundle + canonical aliases for the oldest per type', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache-two' })
  await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })
  const s = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  // suffixed names for every service (envSuffix: kebab -> SNAKE)
  expect(s.REDIS_URL_CACHE).toMatch(/^redis:\/\/default:.+@io-demo-main-rd-cache:6379\/0$/)
  expect(s.REDIS_URL_CACHE_TWO).toContain('io-demo-main-rd-cache-two:6379')
  expect(s.MYSQL_URL_MYSQL_DB).toContain('io-demo-main-my-mysql-db:3306/app')
  // canonical aliases follow the OLDEST service of each type
  expect(s.REDIS_URL).toBe(s.REDIS_URL_CACHE)
  expect(s.REDIS_PASSWORD).toBe(s.REDIS_PASSWORD_CACHE)
  expect(s.MYSQL_URL).toBe(s.MYSQL_URL_MYSQL_DB)
  expect(s.MYSQL_DATABASE).toBe('app')
  // distinct passwords per service
  expect(s.REDIS_PASSWORD_CACHE).not.toBe(s.REDIS_PASSWORD_CACHE_TWO)
  // canonical names are reserved from user secrets
  expect((await put(`/projects/${id}/secrets/REDIS_URL`, { value: 'x' })).statusCode).toBe(400)
  expect((await put(`/projects/${id}/secrets/MONGODB_PASSWORD`, { value: 'x' })).statusCode).toBe(400)
})

test('branch create gives managed dbs a FRESH empty instance + fresh password (no data clone)', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(calls).toContain('md.provision:demo-feat:redis:cache')
  const main = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  const feat = (await get(`/projects/${id}/secrets?branch=feat`)).json().secrets
  expect(feat.REDIS_URL).toContain('io-demo-feat-rd-cache:6379')
  expect(feat.REDIS_PASSWORD).not.toBe(main.REDIS_PASSWORD)
})

test('compute deploys receive the managed-db bundle in env', async () => {
  const seen: Record<string, string>[] = []
  const capture: ComputeAdapter = {
    deploy: async (_ref, o) => { seen.push(o.envVars); return { url: `http://localhost:${o.hostPort}` } },
    destroy: async () => {},
  }
  const local = buildServer(new Engine(db, capture, storage, managed))
  const r = await local.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })
  const pid = r.json().project.id
  await local.inject({ method: 'POST', url: `/projects/${pid}/services`, payload: { type: 'mongodb', name: 'mongo-db' } })
  await local.inject({ method: 'POST', url: `/projects/${pid}/deploy`, payload: { image: 'app:1', branch: 'main', port: 3000 } })
  expect(seen[0].MONGODB_URL).toContain('io-demo-main-mo-mongo-db:27017')
  expect(seen[0].MONGODB_URL_MONGO_DB).toBe(seen[0].MONGODB_URL)
})

test('managed db remove: destroys on every branch, drops rows + secrets; rename re-keys everything', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })

  // rename: adapter renames per branch; id + suffixed names + canonical alias host re-key
  const rn = await post(`/projects/${id}/services/rd-cache/rename`, { name: 'kv' })
  expect(rn.statusCode).toBe(200)
  expect(rn.json().service).toMatchObject({ id: 'rd-kv', name: 'kv', type: 'redis' })
  expect(calls).toContain('md.rename:demo-main:redis:cache->kv')
  expect(calls).toContain('md.rename:demo-feat:redis:cache->kv')
  const s = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(s.REDIS_URL_KV).toContain('io-demo-main-rd-kv:6379')
  expect(s.REDIS_URL_CACHE).toBeUndefined()
  expect(s.REDIS_URL).toBe(s.REDIS_URL_KV)

  // service secret names (names only) + tree place the minted names under the service
  const names = (await get(`/projects/${id}/services/rd-kv/secrets`)).json().secrets
  expect(names).toContain('REDIS_URL_KV')
  const tree = (await get(`/projects/${id}/secrets/tree`)).json()
  const mainBranch = tree.branches.find((b: { name: string }) => b.name === 'main')
  expect(mainBranch.services.find((x: { type: string }) => x.type === 'redis')).toMatchObject({ name: 'kv' })

  // merge reports it as existing structure (data never merges)
  const merge = await post(`/projects/${id}/branches/main/merge`, { from: 'feat' })
  expect(merge.json().skipped).toContainEqual({ type: 'redis', name: 'kv', reason: 'exists' })

  // remove sweeps every branch
  const del = await del_(`/projects/${id}/services/rd-kv`)
  expect(del.statusCode).toBe(200)
  expect(calls).toContain('md.destroy:demo-main:redis:kv')
  expect(calls).toContain('md.destroy:demo-feat:redis:kv')
  const after = (await get(`/projects/${id}/services`)).json().services
  expect(after.find((x: { id: string }) => x.id === 'rd-kv')).toBeUndefined()
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.REDIS_URL).toBeUndefined()
})

// ---- storage objects (platform parity: list / presign download / presign upload / delete) ----

test('object list: shape + paging params + storage.read gate', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/services/st-store/objects?prefix=img/&limit=5`)
  expect(r.statusCode).toBe(200)
  expect(r.json()).toEqual({
    objects: [{ key: 'a.txt', size: 3, lastModified: '2026-08-18T00:00:00Z', etag: '"x"' }],
    nextCursor: 'page2',
  })
  expect(calls).toContain('st.list:io-demo-main:prefix=img/:limit=5')

  await put(`/projects/${id}/policy/storage.read`, { decision: 'approve' })
  const gatedRes = await get(`/projects/${id}/services/st-store/objects`)
  expect(gatedRes.statusCode).toBe(202)
  expect(gatedRes.json()).toMatchObject({ status: 'approval_required', action: 'storage.read' })
})

test('object download presign: {url, expiresAt}; key required; branch-scoped creds', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect((await get(`/projects/${id}/services/st-store/objects/download`)).statusCode).toBe(400)
  const r = await get(`/projects/${id}/services/st-store/objects/download?key=a.txt&branch=feat&disposition=inline`)
  expect(r.statusCode).toBe(200)
  expect(r.json().url).toContain('io-demo-feat/a.txt') // the FEAT bucket, not main's
  expect(r.json().expiresAt).toBeTruthy()
  expect(calls).toContain('st.presignGet:io-demo-feat:a.txt:inline')
})

test('object upload presign: {url, fields, expiresAt}; validates body; storage.write gate; 5GiB cap', async () => {
  const id = await createProject()
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x' })).statusCode).toBe(400)
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x', contentType: 'text/plain', size: 6 * 1024 * 1024 * 1024 })).statusCode).toBe(400)
  const r = await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x.txt', contentType: 'text/plain', size: 10 })
  expect(r.statusCode).toBe(200)
  expect(r.json().fields.key).toBe('x.txt')
  expect(calls).toContain('st.presignPost:io-demo-main:x.txt:text/plain:10')

  await put(`/projects/${id}/policy/storage.write`, { decision: 'deny' })
  expect((await post(`/projects/${id}/services/st-store/objects/upload`, { key: 'x.txt', contentType: 'text/plain', size: 10 })).statusCode).toBe(403)
})

test('object delete: single {deleted:true} + bulk {deleted, failed}; storage.delete gate; storage-only', async () => {
  const id = await createProject()
  const one = await del_(`/projects/${id}/services/st-store/objects?key=a.txt`)
  expect(one.statusCode).toBe(200)
  expect(one.json()).toEqual({ deleted: true })
  expect(calls).toContain('st.rm:io-demo-main:a.txt')

  const bulk = await post(`/projects/${id}/services/st-store/objects/delete`, { keys: ['a.txt', 'b.txt'] })
  expect(bulk.statusCode).toBe(200)
  expect(bulk.json()).toEqual({ deleted: 2, failed: [] })
  expect((await post(`/projects/${id}/services/st-store/objects/delete`, {})).statusCode).toBe(400)

  // only storage services hold objects
  expect((await get(`/projects/${id}/services/pg-db/objects`)).statusCode).toBe(400)

  await put(`/projects/${id}/policy/storage.delete`, { decision: 'approve' })
  expect((await del_(`/projects/${id}/services/st-store/objects?key=a.txt`)).statusCode).toBe(202)
})

test('object routes answer 501 when the storage adapter has no object support', async () => {
  const bare: StorageAdapter = {
    provision: storage.provision, cloneInto: storage.cloneInto, destroy: storage.destroy,
  }
  const local = buildServer(new Engine(db, compute, bare, managed))
  const r = await local.inject({ method: 'POST', url: '/orgs/local/projects', payload: { name: 'demo' } })
  const pid = r.json().project.id
  const res = await local.inject({ method: 'GET', url: `/projects/${pid}/services/st-store/objects` })
  expect(res.statusCode).toBe(501)
  expect(res.json().error).toMatch(/not supported by this storage adapter/)
})

// ---- database management: password / databases / extensions / insight (cloud parity) ----

test('db password: rotates, re-mints DATABASE_URL, gated secrets.read', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/database/password`, { password: "s3cr'et" })
  expect(r.statusCode).toBe(200)
  expect(r.json().password).toBe("s3cr'et")
  expect(r.json().connString).toContain(`:${encodeURIComponent("s3cr'et")}@`)
  expect(calls.some((c) => c.startsWith('db.query:alter user postgres'))).toBe(true)
  // the seam now mints the rotated URL
  const secrets = (await get(`/projects/${id}/secrets?branch=main`)).json().secrets
  expect(secrets.DATABASE_URL).toBe(r.json().connString)
  // omitted password = generated
  const gen = await post(`/projects/${id}/database/password`, {})
  expect(gen.json().password.length).toBeGreaterThan(20)

  await put(`/projects/${id}/policy/secrets.read`, { decision: 'approve' })
  expect((await post(`/projects/${id}/database/password`, {})).statusCode).toBe(202)
})

test('db databases: list with connString, create 201, delete guards primary/system, 404 on ghost', async () => {
  const id = await createProject()
  const list = (await get(`/projects/${id}/database/databases`)).json().databases
  expect(list.map((d: { name: string }) => d.name)).toEqual(['app', 'postgres'])
  expect(list[0].connString).toContain('/app')

  const created = await post(`/projects/${id}/database/databases`, { name: 'analytics' })
  expect(created.statusCode).toBe(201)
  expect(created.json()).toMatchObject({ name: 'analytics' })
  expect(created.json().connString).toContain('/analytics')
  expect((await post(`/projects/${id}/database/databases`, { name: 'bad name!' })).statusCode).toBe(400)

  expect((await del_(`/projects/${id}/database/databases/app`)).statusCode).toBe(400)      // primary
  expect((await del_(`/projects/${id}/database/databases/postgres`)).statusCode).toBe(400) // system
  expect((await del_(`/projects/${id}/database/databases/ghost`)).statusCode).toBe(404)
  const dropped = await del_(`/projects/${id}/database/databases/analytics`)
  expect(dropped.statusCode).toBe(200)
  expect(dropped.json()).toEqual({ ok: true })
  expect(calls.some((c) => c.startsWith('db.query:drop database'))).toBe(true)
})

test('db extensions: view marks required; patch enables/disables; refuses required + unknown', async () => {
  const id = await createProject()
  const view = (await get(`/projects/${id}/database/extensions`)).json()
  expect(view.enabled).toEqual(['pg_stat_statements', 'plpgsql'])
  expect(view.available.find((a: { name: string }) => a.name === 'pg_stat_statements').required).toBe(true)
  expect(view.available.find((a: { name: string }) => a.name === 'vector').required).toBeUndefined()

  const patched = await patch(`/projects/${id}/database/extensions`, { enable: ['vector'] })
  expect(patched.statusCode).toBe(200)
  expect(calls.some((c) => c.startsWith('db.query:create extension'))).toBe(true)
  expect((await patch(`/projects/${id}/database/extensions`, { disable: ['pg_stat_statements'] })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}/database/extensions`, { enable: ['not-a-thing'] })).statusCode).toBe(400)
})

test('db insight: DbInsight shape — sizes, tables, vacuum (null lastVacuum omitted), unused indexes', async () => {
  const id = await createProject()
  const r = await get(`/projects/${id}/database/insight`)
  expect(r.statusCode).toBe(200)
  const insight = r.json()
  expect(insight.collected).toBe(true)
  expect(insight.sizes).toEqual({ databaseBytes: 9000, tablesBytes: 5000, indexesBytes: 2000, walBytes: 100 })
  expect(insight.tables[0]).toEqual({ name: 'users', liveRows: 10, dataBytes: 4096, indexBytes: 1024, seqScans: 5, idxScans: 7 })
  expect(insight.vacuum.totalDeadRows).toBe(2)
  expect(insight.vacuum.tables[0]).toEqual({ name: 'users', deadRows: 2, deadPct: 16.7, xidAge: 55 }) // lastVacuum null → omitted
  expect(insight.unusedIndexes).toEqual([{ name: 'idx_dead', table: 'users', sizeBytes: 512, scans: 0 }])
})

// ---- runtime-health + branch rename (contract parity) ----

test('runtime-health: one docker read maps pg + managed + compute to the cloud vocabulary', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'web' })
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', group: 'web', port: 3000 })
  await post(`/projects/${id}/services`, { type: 'compute', name: 'idle' }) // registered, never deployed

  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) => {
    if (args[0] === 'ps' && args[1] === '-a') {
      return Buffer.from('io-demo-main-pg\trunning\nio-demo-main-rd-cache\tpaused\nio-demo-main-app-web\texited\n')
    }
    return Buffer.from('')
  })
  const r = await get(`/projects/${id}/runtime-health`)
  expect(r.statusCode).toBe(200)
  const byId = Object.fromEntries(r.json().services.map((s: { serviceId: string }) => [s.serviceId, s]))
  expect(byId['pg-db']).toMatchObject({ status: 'healthy', machines: 1, failing: 0 })
  expect(byId['rd-cache']).toMatchObject({ status: 'standby', machines: 1, failing: 0 })     // paused = suspend intent
  expect(byId['cp-web']).toMatchObject({ status: 'crashed', machines: 1, failing: 1 })       // exited against running intent
  expect(byId['cp-idle']).toMatchObject({ status: 'none', machines: 0, failing: 0 })         // never deployed
  vi.mocked(dockerFn).mockImplementation(async () => Buffer.from(''))
})

test('branch rename: metadata-only — resources keep their frozen ref; guards default/conflict', async () => {
  const id = await createProject()
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  await put(`/projects/${id}/secrets/FEAT_ONLY`, { value: 'v', branch: 'feat' })
  const feat = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat')

  const r = await patch(`/projects/${id}/branches/${feat.id}`, { name: 'exp' })
  expect(r.statusCode).toBe(200)
  expect(r.json().branch).toMatchObject({ id: feat.id, name: 'exp', is_default: false })

  // the seam still mints the FROZEN ref's resources, and branch-scoped secrets followed the name
  const secrets = (await get(`/projects/${id}/secrets?branch=exp`)).json().secrets
  expect(secrets.DATABASE_URL).toBe('pg://demo-feat')
  expect(secrets.FEAT_ONLY).toBe('v')
  expect((await get(`/projects/${id}/secrets?branch=feat`)).statusCode).toBe(404) // old name gone

  // deploys on the renamed branch keep landing on the frozen ref
  await post(`/projects/${id}/deploy`, { image: 'app:2', branch: 'exp', port: 3000 })
  expect(calls.some((c) => c.startsWith('deploy:demo-feat:default:app:2'))).toBe(true)

  // guards: default branch, name conflicts, junk names
  const main = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'main')
  expect((await patch(`/projects/${id}/branches/${main.id}`, { name: 'other' })).statusCode).toBe(400)
  await post(`/projects/${id}/branches`, { name: 'feat2', from: 'main' })
  const feat2 = (await get(`/projects/${id}/branches`)).json().branches.find((b: { name: string }) => b.name === 'feat2')
  expect((await patch(`/projects/${id}/branches/${feat2.id}`, { name: 'exp' })).statusCode).toBe(409)
  expect((await patch(`/projects/${id}/branches/${feat2.id}`, { name: 'Bad Name' })).statusCode).toBe(400)
})

// ---- project rename (display-name-only, frozen ref slug — contract parity) ----

test('project rename: display name only; resources AND future branches keep the frozen slug', async () => {
  const id = await createProject() // 'demo' → frozen slug 'demo'
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000 })

  const r = await patch(`/projects/${id}`, { name: 'Shop Backend' }) // any display name, like the cloud
  expect(r.statusCode).toBe(200)
  expect(r.json().project).toMatchObject({ id, name: 'Shop Backend' })
  expect((await get('/orgs/local/projects')).json().projects[0].name).toBe('Shop Backend')

  // existing resources keep serving under the frozen slug
  expect((await get(`/projects/${id}/secrets?branch=main`)).json().secrets.DATABASE_URL).toBe('pg://demo-main')
  // a branch created AFTER the rename still keys on the frozen slug, not the new name
  await post(`/projects/${id}/branches`, { name: 'feat', from: 'main' })
  expect(calls).toContain('db.provision:demo-feat')

  // guards: junk names 400, duplicate display name 409
  expect((await patch(`/projects/${id}`, { name: '  ' })).statusCode).toBe(400)
  expect((await patch(`/projects/${id}`, { name: 'x'.repeat(101) })).statusCode).toBe(400)
  await post('/orgs/local/projects', { name: 'other' })
  expect((await patch(`/projects/${id}`, { name: 'other' })).statusCode).toBe(409)
})

test('create-project guards frozen slugs: a renamed project still owns its original resource names', async () => {
  const id = await createProject() // 'demo', slug frozen
  await patch(`/projects/${id}`, { name: 'shop' })
  // the display name 'demo' is free again, but the SLUG demo is still owned → 409, not a collision
  const r = await post('/orgs/local/projects', { name: 'demo' })
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toMatch(/already exists/)
})

// ---- managed-db observability: component=redis|mysql|mongodb (cloud parity, platform #243) ----

test('metrics/logs target managed-db containers per type; junk components 400', async () => {
  const id = await createProject()
  await post(`/projects/${id}/services`, { type: 'redis', name: 'cache' })
  await post(`/projects/${id}/services`, { type: 'mysql', name: 'mysql-db' })

  const observed: string[][] = []
  vi.mocked(dockerFn).mockImplementation(async (args: readonly string[]) => {
    if (args[0] === 'stats' || args[0] === 'logs') observed.push([...args])
    return Buffer.from('')
  })
  await get(`/projects/${id}/metrics?component=redis`)
  expect(observed.pop()).toContain('io-demo-main-rd-cache')
  await get(`/projects/${id}/logs?component=mysql&group=mysql-db&limit=5`)
  expect(observed.pop()).toContain('io-demo-main-my-mysql-db')
  // group resolves INSIDE the type — a redis named like a compute group must not leak across
  await get(`/projects/${id}/metrics?component=redis&group=nope`)
  expect((await get(`/projects/${id}/metrics?component=redis&group=nope`)).json().series).toEqual([])
  vi.mocked(dockerFn).mockImplementation(async () => Buffer.from(''))

  const bad = await get(`/projects/${id}/metrics?component=kafka`)
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toBe('component must be db|compute|redis|mysql|mongodb')
  expect((await get(`/projects/${id}/logs?component=junk`)).statusCode).toBe(400)
})
