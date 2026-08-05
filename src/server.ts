// The local daemon (instad): serves the SAME endpoint surface (paths + response shapes) as the
// Instacloud platform control-plane, so the stock `insta` CLI and MCP work unchanged — just
// pointed at localhost. Single-tenant: no OAuth; a builtin "local" org/user stand in for the
// account system. Cloud-only surfaces (billing, usage, tokens, members) return 501.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { Engine } from './engine'
import * as govern from './govern'
import { isGatedAction, type Approval, type AuditEvent, type GatedAction } from './types'

const LOCAL_USER = { id: 'local', email: null, name: 'local' }
const LOCAL_ORG = { id: 'local', name: 'local', is_personal: true, role: 'owner' }

const approvalOut = (a: Approval) => ({
  id: a.id, action: a.action, status: a.status, requested_at: a.requestedAt, decided_at: a.decidedAt,
})
const eventOut = (e: AuditEvent) => ({
  id: e.id, branch: e.branch, source: e.source, kind: e.kind, payload: e.payload, created_at: e.createdAt,
})

export function buildServer(engine: Engine): FastifyInstance {
  const app = Fastify({ logger: false })

  // Tolerate bodyless POSTs sent as application/json (the CLI does this on approve/deny).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = (body as string).trim()
    if (s === '') return done(null, undefined)
    try { done(null, JSON.parse(s)) } catch (e) { done(e as Error) }
  })

  const notCloud = (reply: FastifyReply, what: string) =>
    reply.code(501).send({ error: `${what} is cloud-only — insta-oss is a single-tenant local runtime` })

  // Gate a sensitive action; on approval_required reply 202 (the CLI understands this shape).
  const gated = (projectId: string, action: GatedAction, reply: FastifyReply): boolean => {
    const g = govern.gate(projectId, action)
    if (g.decision === 'deny') { reply.code(403).send({ error: `${action} denied by policy` }); return false }
    if (g.decision === 'approval_required') {
      engine.emit(projectId, null, 'govern', 'govern.pending', { action, approvalId: g.approvalId })
      reply.code(202).send({ status: 'approval_required', action, approvalId: g.approvalId })
      return false
    }
    return true
  }

  app.get('/healthz', async () => ({ ok: true }))
  app.get('/me', async () => ({ user: LOCAL_USER }))
  app.get('/orgs', async () => ({ orgs: [LOCAL_ORG] }))
  app.post('/orgs', async (_req, reply) => notCloud(reply, 'org management'))
  app.get('/tokens', async (_req, reply) => notCloud(reply, 'agent tokens'))
  app.get('/orgs/:id/billing', async (_req, reply) => notCloud(reply, 'billing'))
  app.get('/projects/:id/usage', async (_req, reply) => notCloud(reply, 'usage metering'))
  app.get('/orgs/:id/usage', async (_req, reply) => notCloud(reply, 'usage metering'))
  // ---- observability (docker + SQL backed; same response shapes as the cloud) ----
  const obsCode = (m: string): number => (m.includes('not found') ? 404 : 502)
  const component = (q: { component?: string }): 'db' | 'compute' => (q.component === 'db' ? 'db' : 'compute')

  app.get('/projects/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { component?: string; branch?: string; group?: string }
    try { return await engine.runtimeMetrics(id, { component: component(q), branchName: q.branch, group: q.group }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { component?: string; branch?: string; group?: string; limit?: string }
    try { return await engine.runtimeLogs(id, { component: component(q), branchName: q.branch, group: q.group, limit: q.limit ? Number(q.limit) : undefined }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  // Control-plane operation log (cloud: Neon operations; here the resource-event timeline).
  app.get('/projects/:id/operations', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { limit?: string }
    try { return engine.operations(id, q.limit ? Number(q.limit) : undefined) }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // Point-in-time DB signals — run SQL against the branch database (same queries as the cloud).
  app.get('/projects/:id/database/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    try { return await engine.dbMetricsSnapshot(id, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/database/activity', async (req, reply) => {
    const { id } = req.params as { id: string }
    try { return await engine.dbActivity(id, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/database/query-stats', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; limit?: string; sort?: string }
    const sort = (['total', 'mean', 'calls'] as const).find((s) => s === q.sort)
    try { return await engine.dbQueryStats(id, q.branch, { limit: q.limit ? Number(q.limit) : undefined, sort }) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(obsCode(m)).send({ error: m }) }
  })

  app.post('/orgs/:id/projects', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    const { project, defaultBranch } = await engine.createProject(name)
    return reply.code(201).send({
      project: { id: project.id, name: project.name, status: project.status },
      defaultBranch: { id: defaultBranch.id, name: defaultBranch.name },
      resources: [{ kind: 'postgres' }, { kind: 'storage' }, { kind: 'compute' }],
    })
  })

  app.get('/orgs/:id/projects', async () => ({
    projects: engine.listProjects().map((p) => ({ id: p.id, name: p.name, status: p.status })),
  }))

  app.get('/projects/:id', async (req, reply) => {
    try { return engine.detail((req.params as { id: string }).id) }
    catch { return reply.code(404).send({ error: 'project not found' }) }
  })

  app.delete('/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'project.delete', reply)) return reply
    await engine.destroyProject(id)
    return {}
  })

  app.get('/projects/:id/branches', async (req) => ({
    branches: engine.listBranches((req.params as { id: string }).id)
      .map((b) => ({ id: b.id, name: b.name, is_default: b.isDefault, status: b.status })),
  }))

  app.post('/projects/:id/branches', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name, from } = (req.body ?? {}) as { name?: string; from?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    try {
      const b = await engine.createBranch(id, name, from)
      return reply.code(201).send({ branch: { id: b.id, name: b.name } })
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { id, bid } = req.params as { id: string; bid: string }
    if (!gated(id, 'branch.delete', reply)) return reply
    try { await engine.destroyBranch(id, bid); return {} }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // Structural merge: create on the target branch what exists on `from` and is missing there.
  // No data moves — only migration files carry schema forward. Gated — service.add.
  app.post('/projects/:id/branches/:branch/merge', async (req, reply) => {
    const { id, branch } = req.params as { id: string; branch: string }
    const { from } = (req.body ?? {}) as { from?: string }
    if (!from) return reply.code(400).send({ error: 'from (source branch name) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.add', reply)) return reply
    try { return await engine.mergeBranch(id, branch, from) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.startsWith('target') ? 404 : 400).send({ error: m })
    }
  })

  app.get('/projects/:id/secrets', async (req, reply) => {
    const { id } = req.params as { id: string }
    const branch = (req.query as { branch?: string }).branch ?? 'main'
    if (!gated(id, 'secrets.read', reply)) return reply
    try {
      engine.emit(id, branch, 'govern', 'secrets.read', {})
      return { secrets: engine.secrets(id, branch) }
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // The project→branch→service→secrets inventory (names only, no values). Gated — secrets.read.
  app.get('/projects/:id/secrets/tree', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    return engine.secretTree(id)
  })

  app.post('/projects/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { image?: string; branch?: string; group?: string; port?: number }
    if (!body.image) return reply.code(400).send({ error: 'image required' })
    if (!gated(id, 'deploy', reply)) return reply
    try { return await engine.deploy(id, body.branch ?? 'main', { image: body.image, port: body.port, group: body.group }) }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  app.get('/projects/:id/policy', async (req) => ({
    policy: govern.effectivePolicy((req.params as { id: string }).id),
  }))

  app.put('/projects/:id/policy/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string }
    const { decision } = (req.body ?? {}) as { decision?: string }
    if (!isGatedAction(action)) return reply.code(400).send({ error: `unknown action: ${action}` })
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve') {
      return reply.code(400).send({ error: 'decision must be allow|deny|approve' })
    }
    govern.setPolicy(id, action, decision)
    engine.emit(id, null, 'govern', 'policy.set', { action, decision })
    return { policy: govern.effectivePolicy(id) }
  })

  app.get('/projects/:id/approvals', async (req) => {
    const { id } = req.params as { id: string }
    const status = (req.query as { status?: string }).status
    return { approvals: govern.listApprovals(id, status).map(approvalOut) }
  })

  const decideRoute = (verdict: 'granted' | 'denied') => async (req: { params: unknown; body?: unknown }, reply: FastifyReply) => {
    const { id, aid } = req.params as { id: string; aid: string }
    const always = !!((req.body ?? {}) as { always?: boolean }).always
    const a = govern.decide(id, aid, verdict, always)
    if (!a) return reply.code(404).send({ error: 'approval not found or not pending' })
    engine.emit(id, null, 'govern', verdict === 'granted' ? 'govern.approved' : 'govern.denied', { action: a.action, approvalId: a.id, always })
    return { approval: approvalOut(a) }
  }
  app.post('/projects/:id/approvals/:aid/approve', decideRoute('granted'))
  app.post('/projects/:id/approvals/:aid/deny', decideRoute('denied'))

  // ---- services (services-model parity; ?branch= scopes the dashboard's runtime columns) ----
  app.get('/projects/:id/services', async (req, reply) => {
    const branch = (req.query as { branch?: string }).branch
    try { return { services: await engine.services((req.params as { id: string }).id, branch) } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : 'project not found' }) }
  })

  app.post('/projects/:id/services', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { type?: string; name?: string; branch?: string; public?: boolean; volumeGib?: number }
    if (!body.type || !body.name) return reply.code(400).send({ error: 'type and name required' })
    if (!gated(id, 'service.add', reply)) return reply
    // Contract parity: postgres/storage add succeeds idempotently (insta-oss has one of each,
    // auto-provisioned) — the same `services add postgres|storage|compute` script runs on both.
    if (body.type === 'postgres' || body.type === 'storage') {
      try {
        const service = engine.fixedService(id, body.type)
        // `services add storage <name> --public` provisions the bucket public on the cloud;
        // here the bucket already exists, so apply the access mode to it.
        if (body.type === 'storage' && body.public === true) {
          return reply.code(201).send({ service: await engine.setServiceAccess(id, service.id, true, body.branch) })
        }
        return reply.code(201).send({ service })
      } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
    }
    if (body.type !== 'compute') return reply.code(400).send({ error: `unknown service type: ${body.type}` })
    // volumeGib (compute only) attaches a persistent /data volume — create-time ONLY, like the cloud.
    try { return reply.code(201).send({ service: engine.addComputeService(id, body.name, body.volumeGib) }) }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : 400).send({ error: m })
    }
  })

  // ---- service lifecycle + access (contract parity) ----
  // Ungated like the platform; ?branch= scopes the target (default branch otherwise) because
  // oss service ids are stable across branches rather than per-branch rows.
  const errCode = (m: string): number => (m.includes('not found') ? 404 : 400)
  for (const verb of ['start', 'stop', 'suspend'] as const) {
    app.post(`/projects/:id/services/:sid/${verb}`, async (req, reply) => {
      const { id, sid } = req.params as { id: string; sid: string }
      if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
      try { return await engine.lifecycle(id, sid, verb, (req.query as { branch?: string }).branch) }
      catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
    })
  }

  app.get('/projects/:id/services/:sid/state', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try { return await engine.serviceState(id, sid, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // A service's secret names (names only). Gated — secrets.read.
  app.get('/projects/:id/services/:sid/secrets', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'secrets.read', reply)) return reply
    try { return { secrets: engine.serviceSecretNames(id, sid) } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // Storage bucket access mode (anonymous public-read vs private). Gated — service.setAccess.
  app.put('/projects/:id/services/:sid/access', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const body = (req.body ?? {}) as { public?: boolean; branch?: string }
    if (typeof body.public !== 'boolean') return reply.code(400).send({ error: 'public (boolean) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!gated(id, 'service.setAccess', reply)) return reply
    try { return { service: await engine.setServiceAccess(id, sid, body.public, body.branch) } }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // Rename a service and re-key what derives from its name. Gated — service.rename. The fixed
  // postgres/storage pair is name-fixed locally (their minted names are unsuffixed).
  app.post('/projects/:id/services/:sid/rename', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    if (!sid.startsWith('cp-')) {
      return reply.code(501).send({ error: 'renaming postgres/storage services is cloud-only — insta-oss provisions one fixed pair (db/store) per project' })
    }
    if (!gated(id, 'service.rename', reply)) return reply
    try { return { service: await engine.renameComputeService(id, sid.slice(3), name) } }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return reply.code(m.includes('already exists') ? 409 : errCode(m)).send({ error: m })
    }
  })

  // ---- volumes + database settings (tier-caps contract parity, platform #166–169) ----
  // Same paths + shapes as the cloud; oss has no billing tiers, so the cap is one fixed generous
  // constant and recorded sizes are advisory (nothing local enforces a byte quota). Ungated, like
  // lifecycle: the cloud gates growth behind the paid tier, which does not exist here — the
  // grow-only and cap validations stay so one CLI sequence behaves identically on both targets.
  app.get('/projects/:id/services/:sid/volume', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try { return engine.serviceVolume(id, sid) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  app.put('/projects/:id/services/:sid/volume', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    const { sizeGib } = (req.body ?? {}) as { sizeGib?: number }
    if (typeof sizeGib !== 'number') return reply.code(400).send({ error: 'sizeGib (number) required' })
    if (!engine.getProject(id)) return reply.code(404).send({ error: 'project not found' })
    try { return await engine.setServiceVolume(id, sid, sizeGib) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  app.get('/projects/:id/database/instance', async (req, reply) => {
    const { id } = req.params as { id: string }
    try { return engine.dbInstance(id, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  app.patch('/projects/:id/database/settings', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { volumeSize?: string; storageSize?: string }
    try { return engine.dbSettings(id, body, (req.query as { branch?: string }).branch) }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return reply.code(errCode(m)).send({ error: m }) }
  })

  // Machine scaling / instance specs are cloud pricing concepts — clean 501, never a bare 404.
  app.post('/projects/:id/services/:sid/scale', async (_req, reply) => notCloud(reply, 'machine scaling'))
  app.post('/projects/:id/services/:sid/upgrade', async (_req, reply) => notCloud(reply, 'instance spec upgrades'))

  app.delete('/projects/:id/services/:sid', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!sid.startsWith('cp-')) {
      return reply.code(501).send({ error: 'removing postgres/storage services is cloud-only — insta-oss provisions one of each per project' })
    }
    if (!gated(id, 'service.remove', reply)) return reply
    try { await engine.removeComputeService(id, sid.slice(3)); return {} }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // ---- user-defined secrets (insta secrets set/unset) ----
  app.put('/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string }
    const body = (req.body ?? {}) as { value?: string; branch?: string; service?: string }
    if (!body.value) return reply.code(400).send({ error: 'value required' })
    if (!gated(id, 'secrets.write', reply)) return reply
    try { engine.setUserSecret(id, name, body.value, body.branch ?? null, body.service ?? null); return { ok: true } }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  app.delete('/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string }
    const branch = (req.query as { branch?: string }).branch ?? null
    if (!gated(id, 'secrets.write', reply)) return reply
    engine.unsetUserSecret(id, name, branch)
    return { ok: true }
  })

  app.get('/projects/:id/events', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { branch?: string; limit?: string }
    let events = engine.listEvents(id)
    if (q.branch) events = events.filter((e) => e.branch === q.branch)
    const limit = q.limit ? Number(q.limit) : 50
    return { events: events.slice(-limit).map(eventOut) }
  })

  // Agent event ingest (the CLI observe hook uploads credential-audit findings here).
  app.post('/projects/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { kind?: string; branch?: string; payload?: unknown; dedup_key?: string; source?: string }
    if (!body.kind) return reply.code(400).send({ error: 'kind required' })
    engine.emit(id, body.branch ?? null, (body.source as AuditEvent['source']) ?? 'agent', body.kind, body.payload ?? {}, body.dedup_key ?? null)
    return reply.code(201).send({ ok: true })
  })

  // ---- local dashboard: serve ui/dist when built (same origin as the API — localhost trust,
  // no CORS, no auth). API routes above always win; unknown non-API GETs fall back to the SPA.
  const uiDist = process.env.INSTA_OSS_UI_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist')
  const isApiPath = (url: string): boolean =>
    ['/projects', '/orgs', '/me', '/tokens', '/healthz'].some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))
  if (existsSync(join(uiDist, 'index.html'))) {
    app.register(fastifyStatic, { root: uiDist, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !isApiPath(req.url)) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'not found' })
    })
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(
      '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h2>insta-oss daemon</h2><p>The API is up. To get the dashboard, build the UI once:</p><pre>npm run build:ui</pre><p>then restart <code>instad</code>.</p></body>'))
  }

  return app
}
