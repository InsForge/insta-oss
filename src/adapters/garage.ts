import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { docker } from '../docker'
import type { StorageAdapter } from '../types'

// One SHARED Garage server (io-garage) serves every project; each branch gets its own bucket
// AND its own access key scoped to exactly that bucket — a leaked branch credential can touch
// nothing else (verified: foreign buckets 403). S3-compatible, objects on a local docker volume.
// The container is attached to each branch network on provision so apps reach it at
// http://io-garage:3900 — mirroring how the cloud injects an S3 endpoint. Clone = bucket copy
// (rclone sync). Public access = Garage's web endpoint (:3902, vhost per bucket).
const GARAGE = 'io-garage'
const IMAGE = 'dxflrs/garage:v2.3.0'
const RCLONE = 'rclone/rclone'
const S3_PORT = 3900
const WEB_PORT = 3902
const ADMIN_KEY = 'io-insta-admin' // internal key for clone/teardown; granted rw per bucket
const bucketOf = (ref: string): string => `io-${ref}`
const keyNameOf = (ref: string): string => `io-${ref}`

const configPath = (): string =>
  process.env.INSTA_OSS_GARAGE_CONFIG ?? join(homedir(), '.insta-oss', 'garage.toml')

export class LocalGarage implements StorageAdapter {
  private ensured = false
  private adminCreds: { id: string; secret: string } | null = null

  private garage(args: string[]): Promise<Buffer> {
    return docker(['exec', GARAGE, '/garage', ...args])
  }

  /** Write the single-node config once (rpc secret persisted inside it). */
  private ensureConfig(): string {
    const p = configPath()
    if (!existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        'replication_factor = 1',
        'rpc_bind_addr = "[::]:3901"',
        `rpc_secret = "${randomBytes(32).toString('hex')}"`,
        '[s3_api]',
        's3_region = "garage"',
        `api_bind_addr = "[::]:${S3_PORT}"`,
        'root_domain = ".s3.garage.localhost"',
        '[s3_web]',
        `bind_addr = "[::]:${WEB_PORT}"`,
        'root_domain = ".web.garage.localhost"',
        'index = "index.html"',
        '',
      ].join('\n'))
    }
    return p
  }

  /** Start the shared Garage once (idempotent) and initialize the single-node layout. */
  private async ensure(): Promise<void> {
    if (this.ensured) return
    const cfg = this.ensureConfig()
    const out = await docker(['ps', '-aq', '--filter', `name=^${GARAGE}$`])
    if (out.toString().trim()) {
      await docker(['start', GARAGE]).catch(() => { /* already running */ })
    } else {
      const base = ['run', '-d', '--restart', 'unless-stopped', '--name', GARAGE,
        '-v', `${cfg}:/etc/garage.toml:ro`,
        '-v', 'io-garage-meta:/var/lib/garage/meta', '-v', 'io-garage-data:/var/lib/garage/data']
      // host ports are best-effort convenience (S3 + public web endpoint from the host)
      try { await docker([...base, '-p', `${S3_PORT}:${S3_PORT}`, '-p', `${WEB_PORT}:${WEB_PORT}`, IMAGE]) }
      catch {
        await docker([...base, IMAGE])
          .catch(() => docker(['start', GARAGE]).catch(() => { /* concurrently created & running */ }))
      }
    }
    await this.waitReady()
    await this.initLayout()
    this.ensured = true
  }

  private async waitReady(tries = 30): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try { await this.garage(['status']); return } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('shared Garage server never became ready')
  }

  /** Single-node layout: assign this node a role once; later calls see a role and skip. */
  private async initLayout(): Promise<void> {
    const status = (await this.garage(['status'])).toString()
    if (!status.includes('NO ROLE ASSIGNED')) return
    const line = status.split('\n').find((l) => l.includes('NO ROLE ASSIGNED'))
    const nodeId = line?.trim().split(/\s+/)[0]
    if (!nodeId) throw new Error('could not determine Garage node id from status output')
    await this.garage(['layout', 'assign', '-z', 'dc1', '-c', '100G', nodeId])
    await this.garage(['layout', 'apply', '--version', '1']).catch(() => { /* concurrent init won */ })
  }

  /** Key IDs (GK…) for a key NAME. Garage names aren't unique, so all key management goes
   *  through ids — never `key info <name>`, which errors as soon as a duplicate exists. */
  private async keyIds(name: string): Promise<string[]> {
    const out = (await this.garage(['key', 'list'])).toString()
    return out.split('\n')
      .map((l) => l.trim().split(/\s+/)) // columns: ID  Created  Name  Expiration
      .filter((cols) => cols[2] === name && cols[0]?.startsWith('GK'))
      .map((cols) => cols[0])
  }

  /** Create-or-fetch an access key; returns its S3 credentials. */
  private async keyCreds(name: string): Promise<{ id: string; secret: string }> {
    const parse = (raw: string): { id: string; secret: string } | null => {
      const m = /Key ID:\s+(\S+)[\s\S]*?Secret key:\s+(\S+)/.exec(raw)
      return m ? { id: m[1], secret: m[2] } : null
    }
    const existing = await this.keyIds(name)
    if (existing.length) {
      const got = parse((await this.garage(['key', 'info', existing[0], '--show-secret'])).toString())
      if (got) return got
    }
    // `key create` prints the new key's info block, secret included — parse it directly.
    const created = parse((await this.garage(['key', 'create', name])).toString())
    if (created) return created
    const ids = await this.keyIds(name)
    if (!ids.length) throw new Error(`could not read credentials for Garage key ${name}`)
    const got = parse((await this.garage(['key', 'info', ids[0], '--show-secret'])).toString())
    if (!got) throw new Error(`could not read credentials for Garage key ${name}`)
    return got
  }

  private async admin(): Promise<{ id: string; secret: string }> {
    if (!this.adminCreds) this.adminCreds = await this.keyCreds(ADMIN_KEY)
    return this.adminCreds
  }

  /** Run an rclone command in a throwaway container on `network` (so io-garage resolves). */
  private async rclone(network: string, creds: { id: string; secret: string }, args: string[], input?: Buffer): Promise<Buffer> {
    return docker(['run', '--rm', '-i', '--network', network,
      '-e', 'RCLONE_CONFIG_G_TYPE=s3', '-e', 'RCLONE_CONFIG_G_PROVIDER=Other',
      '-e', `RCLONE_CONFIG_G_ENDPOINT=http://${GARAGE}:${S3_PORT}`, '-e', 'RCLONE_CONFIG_G_REGION=garage',
      '-e', `RCLONE_CONFIG_G_ACCESS_KEY_ID=${creds.id}`, '-e', `RCLONE_CONFIG_G_SECRET_ACCESS_KEY=${creds.secret}`,
      RCLONE, ...args], { input })
  }

  async provision(ref: string, network: string): Promise<{ bucket: string; env: Record<string, string> }> {
    await this.ensure()
    // attach the shared Garage to this branch's network so the app (and rclone) can reach it
    await docker(['network', 'connect', network, GARAGE]).catch(() => { /* already attached */ })
    const bucket = bucketOf(ref)
    await this.garage(['bucket', 'create', bucket]).catch(() => { /* exists */ })
    // grants go by key ID — names aren't unique in Garage, so a name here would break on dupes
    const creds = await this.keyCreds(keyNameOf(ref))
    await this.garage(['bucket', 'allow', '--read', '--write', bucket, '--key', creds.id])
    // the internal admin key gets rw too — clone and teardown run under it
    const admin = await this.admin()
    await this.garage(['bucket', 'allow', '--read', '--write', bucket, '--key', admin.id])
    return {
      bucket,
      env: {
        AWS_ACCESS_KEY_ID: creds.id,
        AWS_SECRET_ACCESS_KEY: creds.secret,
        AWS_ENDPOINT_URL_S3: `http://${GARAGE}:${S3_PORT}`,
        AWS_REGION: 'garage',
        BUCKET_NAME: bucket,
      },
    }
  }

  /** Branch clone: copy every object from the source bucket into the destination's. */
  async cloneInto(srcRef: string, dstRef: string, network: string): Promise<void> {
    await this.rclone(network, await this.admin(), ['sync', `g:${bucketOf(srcRef)}`, `g:${bucketOf(dstRef)}`])
  }

  /** Bucket access mode: anonymous public-read via Garage's web endpoint (vhost per bucket,
   *  http://<bucket>.web.garage.localhost:3902 from the host) vs private. */
  async setAccess(ref: string, _network: string, isPublic: boolean): Promise<void> {
    await this.garage(['bucket', 'website', isPublic ? '--allow' : '--deny', bucketOf(ref)])
  }

  async destroy(ref: string, network: string): Promise<void> {
    try { await this.rclone(network, await this.admin(), ['purge', `g:${bucketOf(ref)}`]) } catch { /* empty / gone */ }
    await this.garage(['bucket', 'delete', '--yes', bucketOf(ref)]).catch(() => { /* gone */ })
    for (const id of await this.keyIds(keyNameOf(ref)).catch(() => [] as string[])) {
      await this.garage(['key', 'delete', '--yes', id]).catch(() => { /* gone */ })
    }
    await docker(['network', 'disconnect', network, GARAGE]).catch(() => { /* not attached */ })
  }

  // Test helpers (also handy for debugging): put/get/list objects via rclone.
  putObject(network: string, ref: string, key: string, body: string): Promise<Buffer> {
    return this.admin().then((c) => this.rclone(network, c, ['rcat', `g:${bucketOf(ref)}/${key}`], Buffer.from(body)))
  }
  async getObject(network: string, ref: string, key: string): Promise<string> {
    return (await this.rclone(network, await this.admin(), ['cat', `g:${bucketOf(ref)}/${key}`])).toString()
  }
  async listObjects(network: string, ref: string): Promise<string> {
    return (await this.rclone(network, await this.admin(), ['ls', `g:${bucketOf(ref)}`])).toString()
  }
}
