// RailwayCompute contract tests: the adapter drives Railway's public GraphQL API with the
// USER'S token against the USER'S project — no docker socket anywhere. GraphQL calls are
// captured by a fake fetch so every test asserts the exact operations sent.
import { test, expect, beforeEach } from 'vitest'
import { RailwayCompute } from '../src/adapters/railway'

type Call = { query: string; variables: Record<string, unknown> }
let calls: Call[] = []
/** Existing services in the fake project, keyed by name. */
let existing: Record<string, string> = {}

const fakeFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Call
  calls.push(body)
  const q = body.query
  const respond = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  if (q.includes('query project')) {
    return respond({
      project: { services: { edges: Object.entries(existing).map(([name, id]) => ({ node: { id, name } })) } },
    })
  }
  if (q.includes('serviceCreate')) return respond({ serviceCreate: { id: 'svc-new' } })
  if (q.includes('serviceInstanceUpdate')) return respond({ serviceInstanceUpdate: true })
  if (q.includes('serviceInstanceDeployV2') || q.includes('serviceInstanceDeploy')) return respond({ serviceInstanceDeploy: true })
  if (q.includes('variableCollectionUpsert')) return respond({ variableCollectionUpsert: true })
  if (q.includes('serviceDomainCreate')) return respond({ serviceDomainCreate: { domain: 'io-demo-main-app-default-production.up.railway.app' } })
  if (q.includes('serviceDelete')) return respond({ serviceDelete: true })
  return respond({})
}

const adapter = () => new RailwayCompute({
  token: 't-test', projectId: 'prj-1', environmentId: 'env-1', fetchImpl: fakeFetch,
})

beforeEach(() => { calls = []; existing = {} })

const ops = () => calls.map((c) => /mutation (\w+)|query (\w+)/.exec(c.query)?.[1] ?? /(\w+)\(/.exec(c.query)?.[1]).join(',')

test('deploy on a fresh ref: creates the service from the image, sets env + PORT, adds a domain, returns its URL', async () => {
  const { url } = await adapter().deploy('demo-main', {
    image: 'ghcr.io/you/app:1', port: 3000, envVars: { DATABASE_URL: 'pg://x', BUCKET_NAME: 'b' }, group: 'default',
  })
  expect(url).toBe('https://io-demo-main-app-default-production.up.railway.app')

  const create = calls.find((c) => c.query.includes('serviceCreate'))!
  expect(create.variables.input).toMatchObject({
    projectId: 'prj-1', name: 'io-demo-main-app-default', source: { image: 'ghcr.io/you/app:1' },
  })
  const vars = calls.find((c) => c.query.includes('variableCollectionUpsert'))!
  expect(vars.variables.input).toMatchObject({
    projectId: 'prj-1', environmentId: 'env-1', serviceId: 'svc-new',
    variables: { DATABASE_URL: 'pg://x', BUCKET_NAME: 'b', PORT: '3000' }, // PORT pinned — Railway lesson
  })
  const domain = calls.find((c) => c.query.includes('serviceDomainCreate'))!
  expect(domain.variables.input).toMatchObject({ environmentId: 'env-1', serviceId: 'svc-new', targetPort: 3000 })
})

test('redeploy of an existing service: no serviceCreate — updates the image and redeploys', async () => {
  existing = { 'io-demo-main-app-default': 'svc-42' }
  await adapter().deploy('demo-main', { image: 'app:2', port: 3000, envVars: {}, group: 'default' })
  expect(calls.some((c) => c.query.includes('serviceCreate'))).toBe(false)
  const upd = calls.find((c) => c.query.includes('serviceInstanceUpdate'))!
  expect(upd.variables).toMatchObject({ serviceId: 'svc-42', environmentId: 'env-1', input: { source: { image: 'app:2' } } })
  expect(calls.some((c) => c.query.includes('serviceInstanceDeploy'))).toBe(true)
})

test('destroy removes every compute service of the ref and nothing else', async () => {
  existing = {
    'io-demo-feat-app-default': 'svc-a',
    'io-demo-feat-app-worker': 'svc-b',
    'io-demo-main-app-default': 'svc-keep',
    'io-pg': 'svc-infra',
  }
  await adapter().destroy('demo-feat')
  const deleted = calls.filter((c) => c.query.includes('serviceDelete')).map((c) => c.variables.id)
  expect(deleted.sort()).toEqual(['svc-a', 'svc-b'])
})

test('GraphQL errors surface as thrown errors, not silent success', async () => {
  const failing: typeof fetch = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }), { status: 200 })
  const a = new RailwayCompute({ token: 'bad', projectId: 'p', environmentId: 'e', fetchImpl: failing })
  await expect(a.deploy('r', { image: 'i', port: 1, envVars: {}, group: 'g' })).rejects.toThrow(/Not Authorized/)
})
