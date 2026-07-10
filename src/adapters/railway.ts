// Custom compute on Railway: the same ComputeAdapter contract as DockerCompute, but the
// "control plane" is Railway's public GraphQL API instead of the local docker daemon — no
// socket anywhere. BYO credentials: the USER'S token drives the USER'S Railway project
// (set INSTA_OSS_COMPUTE=railway + RAILWAY_TOKEN / RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID).
//
// Railway lessons baked in (learned live, 2026-07-09): the proxy and private network are
// IPv6-only (apps must bind `::` — documented, we can't fix their image), and PORT must be
// pinned to the domain's target port or the app 502s despite booting fine.
import type { ComputeAdapter } from '../types'

const API = 'https://backboard.railway.com/graphql/v2'
const appName = (ref: string, group: string): string => `io-${ref}-app-${group}`

export interface RailwayConfig {
  token: string
  projectId: string
  environmentId: string
  fetchImpl?: typeof fetch // DI for tests
}

export class RailwayCompute implements ComputeAdapter {
  constructor(private cfg: RailwayConfig) {}

  private async gql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    const doFetch = this.cfg.fetchImpl ?? fetch
    const res = await doFetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` },
      body: JSON.stringify({ query, variables }),
    })
    const body = await res.json() as { data?: T; errors?: Array<{ message: string }> }
    if (!res.ok || body.errors?.length) {
      throw new Error(`railway api: ${body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`}`)
    }
    return body.data as T
  }

  /** name → service id for every service in the configured project. */
  private async services(): Promise<Record<string, string>> {
    const data = await this.gql(
      'query project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }',
      { id: this.cfg.projectId },
    )
    const out: Record<string, string> = {}
    for (const e of data.project?.services?.edges ?? []) out[e.node.name] = e.node.id
    return out
  }

  async deploy(
    ref: string,
    opts: { image: string; port: number; hostPort?: number; envVars: Record<string, string>; network?: string; group: string },
  ): Promise<{ url: string }> {
    const name = appName(ref, opts.group)
    const existing = (await this.services())[name]

    let serviceId: string
    if (existing) {
      serviceId = existing
      await this.gql(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
           serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
        { serviceId, environmentId: this.cfg.environmentId, input: { source: { image: opts.image } } },
      )
    } else {
      const created = await this.gql(
        `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
        { input: { projectId: this.cfg.projectId, name, source: { image: opts.image } } },
      )
      serviceId = created.serviceCreate.id
    }

    // Env vars + PORT pinned to the exposed port (the 502-forever trap otherwise).
    await this.gql(
      `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
      {
        input: {
          projectId: this.cfg.projectId,
          environmentId: this.cfg.environmentId,
          serviceId,
          variables: { ...opts.envVars, PORT: String(opts.port) },
        },
      },
    )

    let domain: string | undefined
    try {
      const d = await this.gql(
        `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
        { input: { environmentId: this.cfg.environmentId, serviceId, targetPort: opts.port } },
      )
      domain = d.serviceDomainCreate?.domain
    } catch {
      // domain already exists (redeploys) — read it back instead
      const d = await this.gql(
        `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
           domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
             serviceDomains { domain } } }`,
        { projectId: this.cfg.projectId, environmentId: this.cfg.environmentId, serviceId },
      )
      domain = d.domains?.serviceDomains?.[0]?.domain
    }

    if (existing) {
      await this.gql(
        `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
           serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
        { serviceId, environmentId: this.cfg.environmentId },
      )
    }

    return { url: domain ? `https://${domain}` : `railway:${serviceId}` }
  }

  async destroy(ref: string): Promise<void> {
    const prefix = `io-${ref}-app-`
    const all = await this.services()
    for (const [name, id] of Object.entries(all)) {
      if (!name.startsWith(prefix)) continue
      await this.gql(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id })
    }
  }
}
