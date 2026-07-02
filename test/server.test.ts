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
  deploy: async (ref, o) => { calls.push(`deploy:${ref}:${o.group}:${o.image}:s3=${o.envVars.BUCKET_NAME ?? 'none'}`); return { url: `http://localhost:${o.port}` } },
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
  expect(calls).toContain('deploy:demo-feat:default:app:1:s3=io-demo-feat') // redeploy wired to the CLONE's bucket

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
