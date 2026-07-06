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
  app.get('/projects/:id/metrics', async (_req, reply) => notCloud(reply, 'metrics (coming to insta-oss via docker stats)'))
  app.get('/projects/:id/logs', async (_req, reply) => notCloud(reply, 'logs (coming to insta-oss via docker logs)'))

  app.post('/orgs/:id/projects', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.code(400).send({ error: 'name required' })
    const { project, defaultBranch } = await engine.createProject(name)
    return {
      project: { id: project.id, name: project.name, status: project.status },
      defaultBranch: { id: defaultBranch.id, name: defaultBranch.name },
      resources: [{ kind: 'postgres' }, { kind: 'storage' }, { kind: 'compute' }],
    }
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
    return { ok: true }
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
      return { branch: { id: b.id, name: b.name } }
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.delete('/projects/:id/branches/:bid', async (req, reply) => {
    const { id, bid } = req.params as { id: string; bid: string }
    if (!gated(id, 'branch.delete', reply)) return reply
    try { await engine.destroyBranch(id, bid); return { ok: true } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
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
    const body = (req.body ?? {}) as { type?: string; name?: string }
    if (!body.type || !body.name) return reply.code(400).send({ error: 'type and name required' })
    if (body.type !== 'compute') {
      return reply.code(501).send({ error: `multi-${body.type} services are cloud-only for now — insta-oss provisions one postgres + one storage per project` })
    }
    if (!gated(id, 'service.add', reply)) return reply
    try { return { service: engine.addComputeService(id, body.name) } }
    catch (e) { return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  app.delete('/projects/:id/services/:sid', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string }
    if (!sid.startsWith('cp-')) {
      return reply.code(501).send({ error: 'removing postgres/storage services is cloud-only — insta-oss provisions one of each per project' })
    }
    if (!gated(id, 'service.remove', reply)) return reply
    try { await engine.removeComputeService(id, sid.slice(3)); return { ok: true } }
    catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }) }
  })

  // ---- user-defined secrets (insta secrets set/unset) ----
  app.put('/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string }
    const body = (req.body ?? {}) as { value?: string; branch?: string }
    if (!body.value) return reply.code(400).send({ error: 'value required' })
    if (!gated(id, 'secrets.write', reply)) return reply
    try { engine.setUserSecret(id, name, body.value, body.branch ?? null); return { ok: true } }
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
