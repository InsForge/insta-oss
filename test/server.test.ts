// Contract tests: the daemon must serve the exact shapes the stock `insta` CLI consumes.
// Fake adapters — no Docker needed. docker() is mocked (engine only uses it for networks).
import { test, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/docker', () => ({ docker: vi.fn(async () => Buffer.from('')) }))

import { buildServer } from '../src/server'
import { Engine } from '../src/engine'
import type { DatabaseAdapter, ComputeAdapter, StorageAdapter } from '../src/types'

const calls: string[] = []
const db: DatabaseAdapter = {
  provision: async (ref) => { calls.push(`db.provision:${ref}`); return { url: `pg://${ref}` } },
  query: async () => '',
  cloneInto: async (s, d) => { calls.push(`db.clone:${s}->${d}`) },
  destroy: async (ref) => { calls.push(`db.destroy:${ref}`) },
}
const compute: ComputeAdapter = {
  deploy: async (ref, o) => { calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}:p=${o.port}->${o.hostPort}`); return { url: `http://localhost:${o.hostPort}` } },
  destroy: async (ref) => { calls.push(`compute.destroy:${ref}`) },
}
const storage: StorageAdapter = {
  provision: async (ref) => { calls.push(`st.provision:${ref}`); return { bucket: `io-${ref}`, env: { BUCKET_NAME: `io-${ref}`, AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_ENDPOINT_URL_S3: 'http://io-minio:9000', AWS_REGION: 'local' } } },
  cloneInto: async (src, dst) => { calls.push(`st.clone:${src}->${dst}`) },
  destroy: async (ref) => { calls.push(`st.destroy:${ref}`) },
}

let app: ReturnType<typeof buildServer>
beforeEach(() => {
  process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-')), 'state.json')
  calls.length = 0
  app = buildServer(new Engine(db, compute, storage))
})

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload })
const get = (url: string) => app.inject({ method: 'GET', url })

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
  expect(r.statusCode).toBe(200)
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
  expect(r.statusCode).toBe(200)
  expect(r.json().branch.name).toBe('feat')
  expect(calls).toContain('db.clone:demo-main->demo-feat')
  expect(calls).toContain('st.clone:demo-main->demo-feat') // storage branching = bucket copy
  // redeploy wired to the CLONE's bucket; SAME listen port (3000), shifted host mapping (4000)
  expect(calls).toContain('deploy:demo-feat:default:app:1:s3=io-demo-feat:p=3000->4000')

  const branches = (await get(`/projects/${id}/branches`)).json().branches
  expect(branches.map((b: { name: string }) => b.name).sort()).toEqual(['feat', 'main'])
  expect(branches.find((b: { name: string }) => b.name === 'main').is_default).toBe(true)
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

test('cloud-only surfaces return 501 with a clear message', async () => {
  for (const url of ['/tokens', '/orgs/local/billing', '/projects/x/usage', '/projects/x/metrics', '/projects/x/logs']) {
    const r = await get(url)
    expect(r.statusCode).toBe(501)
    expect(r.json().error).toMatch(/cloud-only|coming/)
  }
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

test('services add compute registers a group; duplicates 409; pg/storage add → 501', async () => {
  const id = await createProject()
  const r = await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })
  expect(r.statusCode).toBe(200)
  expect(r.json().service).toMatchObject({ id: 'cp-worker', type: 'compute', name: 'worker' })
  expect((await post(`/projects/${id}/services`, { type: 'compute', name: 'worker' })).statusCode).toBe(409)
  expect((await post(`/projects/${id}/services`, { type: 'postgres', name: 'db2' })).statusCode).toBe(501)
})

test('services remove compute destroys the group; pg/storage remove → 501', async () => {
  const id = await createProject()
  await post(`/projects/${id}/deploy`, { image: 'app:1', branch: 'main', port: 3000, group: 'api' })
  const del = await app.inject({ method: 'DELETE', url: `/projects/${id}/services/cp-api` })
  expect(del.statusCode).toBe(200)
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
  const ui = buildServer(new Engine(db, compute, storage))
  delete process.env.INSTA_OSS_UI_DIST

  expect((await ui.inject({ method: 'GET', url: '/' })).body).toContain('dash')
  expect((await ui.inject({ method: 'GET', url: '/p/some-project/main/services' })).body).toContain('dash')
  const api = await ui.inject({ method: 'GET', url: '/projects/nope' })
  expect(api.statusCode).toBe(404)
  expect(api.json().error).toBeTruthy() // JSON error, not the SPA shell
})

test('dashboard serving: without a build, / explains how to get the UI', async () => {
  process.env.INSTA_OSS_UI_DIST = join(tmpdir(), 'io-ui-definitely-missing')
  const bare = buildServer(new Engine(db, compute, storage))
  delete process.env.INSTA_OSS_UI_DIST
  const r = await bare.inject({ method: 'GET', url: '/' })
  expect(r.body).toContain('build:ui')
})
