#!/usr/bin/env -S npx tsx
// instad — the Instacloud-oss local daemon. Binds 127.0.0.1 (localhost trust; no OAuth).
// The stock `insta` CLI defaults to http://localhost:8080, so an unconfigured CLI Just Works.
import { buildServer } from './server'
import { Engine } from './engine'
import { LocalPostgres } from './adapters/postgres'
import { DockerCompute } from './adapters/compute'
import { RailwayCompute } from './adapters/railway'
import { LocalMinio } from './adapters/storage'
import type { ComputeAdapter } from './types'
import { docker } from './docker'

const portFlag = process.argv.indexOf('--port')
const port = Number(process.env.INSTA_OSS_PORT ?? (portFlag === -1 ? undefined : process.argv[portFlag + 1]) ?? 8080)

// Compute is adapter-selected: local docker (default) or a platform control plane.
// INSTA_OSS_COMPUTE=railway → branch apps become Railway services in YOUR project,
// created with YOUR token (db/storage stay local until the no-socket phase lands).
function pickCompute(): ComputeAdapter {
  if (process.env.INSTA_OSS_COMPUTE !== 'railway') return new DockerCompute()
  const token = process.env.RAILWAY_TOKEN
  const projectId = process.env.RAILWAY_PROJECT_ID
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID
  if (!token || !projectId || !environmentId) {
    console.error('error: INSTA_OSS_COMPUTE=railway needs RAILWAY_TOKEN, RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID')
    process.exit(1)
  }
  console.log(`compute: Railway (project ${projectId})`)
  return new RailwayCompute({ token, projectId, environmentId })
}

async function main(): Promise<void> {
  try { await docker(['version', '--format', '{{.Server.Version}}']) }
  catch { console.error('error: Docker is required and must be running (insta-oss provisions branches as containers)'); process.exit(1) }

  const engine = new Engine(new LocalPostgres(), pickCompute(), new LocalMinio())
  const app = buildServer(engine)
  await app.listen({ host: '127.0.0.1', port })
  console.log(`insta-oss daemon listening on http://127.0.0.1:${port}`)
  console.log('point the insta CLI here (this is its default):')
  console.log('  insta project create <name>   # then branch/deploy/secrets/manifest as usual')
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
