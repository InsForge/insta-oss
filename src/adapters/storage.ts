import { docker } from '../docker'
import type { StorageAdapter } from '../types'

// One SHARED MinIO container (io-minio) serves every project; each branch gets its own
// bucket (io-<ref>). S3-compatible, objects on local disk. The MinIO container is attached
// to each branch network on provision so apps reach it at http://io-minio:9000 — mirroring
// how the cloud injects a Tigris endpoint. Clone = bucket copy (mc mirror).
const MINIO = 'io-minio'
const IMAGE = 'minio/minio'
const MC_IMAGE = 'minio/mc'
const USER = 'insta'
const PASS = 'insta-local-secret'
const bucketOf = (ref: string): string => `io-${ref}`

export class LocalMinio implements StorageAdapter {
  private ensured = false

  /** Start the shared MinIO once (idempotent). Host port 9000 is best-effort convenience. */
  private async ensure(): Promise<void> {
    if (this.ensured) return
    const out = await docker(['ps', '-aq', '--filter', `name=^${MINIO}$`])
    if (out.toString().trim()) {
      await docker(['start', MINIO]).catch(() => { /* already running */ })
    } else {
      const base = ['run', '-d', '--name', MINIO,
        '-e', `MINIO_ROOT_USER=${USER}`, '-e', `MINIO_ROOT_PASSWORD=${PASS}`]
      try { await docker([...base, '-p', '9000:9000', IMAGE, 'server', '/data']) }
      catch {
        // host port busy → in-network only; name conflict → another process won the race
        await docker([...base, IMAGE, 'server', '/data'])
          .catch(() => docker(['start', MINIO]).catch(() => { /* concurrently created & running */ }))
      }
    }
    await this.waitReady()
    this.ensured = true
  }

  // Run an mc command in a throwaway container on `network` (so io-minio resolves).
  private mc(network: string, args: string[], input?: Buffer): Promise<Buffer> {
    return docker(['run', '--rm', '-i', '--network', network,
      '-e', `MC_HOST_m=http://${USER}:${PASS}@${MINIO}:9000`, MC_IMAGE, ...args], { input })
  }

  private async waitReady(tries = 30): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try { await docker(['exec', MINIO, 'mc', 'ready', 'local']); return } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('shared MinIO never became ready')
  }

  async provision(ref: string, network: string): Promise<{ bucket: string; env: Record<string, string> }> {
    await this.ensure()
    // attach the shared MinIO to this branch's network so the app (and mc) can reach it
    await docker(['network', 'connect', network, MINIO]).catch(() => { /* already attached */ })
    const bucket = bucketOf(ref)
    await this.mc(network, ['mb', '-p', `m/${bucket}`])
    return {
      bucket,
      env: {
        AWS_ACCESS_KEY_ID: USER,
        AWS_SECRET_ACCESS_KEY: PASS,
        AWS_ENDPOINT_URL_S3: `http://${MINIO}:9000`,
        AWS_REGION: 'local',
        BUCKET_NAME: bucket,
      },
    }
  }

  /** Branch clone: copy every object from the source bucket into the destination's. */
  async cloneInto(srcRef: string, dstRef: string, network: string): Promise<void> {
    await this.mc(network, ['mirror', '--overwrite', `m/${bucketOf(srcRef)}`, `m/${bucketOf(dstRef)}`])
  }

  async destroy(ref: string, network: string): Promise<void> {
    try { await this.mc(network, ['rb', '--force', `m/${bucketOf(ref)}`]) } catch { /* gone / minio down */ }
    await docker(['network', 'disconnect', network, MINIO]).catch(() => { /* not attached */ })
  }

  // Test helpers (also handy for debugging): put/get an object via mc pipe/cat.
  putObject(network: string, ref: string, key: string, body: string): Promise<Buffer> {
    return this.mc(network, ['pipe', `m/${bucketOf(ref)}/${key}`], Buffer.from(body))
  }
  async getObject(network: string, ref: string, key: string): Promise<string> {
    return (await this.mc(network, ['cat', `m/${bucketOf(ref)}/${key}`])).toString()
  }
  async listObjects(network: string, ref: string): Promise<string> {
    return (await this.mc(network, ['ls', `m/${bucketOf(ref)}`])).toString()
  }
}
