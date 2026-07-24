// Integration (real Docker + Garage): storage branching = bucket copy, isolated; creds are bucket-scoped.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalGarage } from '../src/adapters/garage'

const storage = new LocalGarage()
const engine = new Engine(new LocalPostgres(), new DockerCompute(), storage)
let projectId = ''

const teardown = async () => { try { if (projectId) await engine.destroyProject(projectId) } catch {} }

beforeAll(() => { process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-st-')), 'state.json') })
afterAll(teardown)

test('branch create copies the bucket; clone writes never touch the source bucket', async () => {
  const { project } = await engine.createProject('sttest')
  projectId = project.id
  const mainNet = 'io-sttest-main'
  const featNet = 'io-sttest-feat'

  await storage.putObject(mainNet, 'sttest-main', 'hello.txt', 'from-main')

  await engine.createBranch(projectId, 'feat')

  // clone received the object
  expect(await storage.getObject(featNet, 'sttest-feat', 'hello.txt')).toBe('from-main')

  // write only to the clone → source bucket unchanged
  await storage.putObject(featNet, 'sttest-feat', 'only-in-feat.txt', 'x')
  const mainList = await storage.listObjects(mainNet, 'sttest-main')
  expect(mainList).toContain('hello.txt')
  expect(mainList).not.toContain('only-in-feat.txt')
})

test('branch credentials are scoped: a branch key cannot touch another branch bucket', async () => {
  // main's own creds work on main's bucket…
  const branches = engine.listBranches(projectId)
  const main = branches.find((b) => b.name === 'main')!
  const feat = branches.find((b) => b.name === 'feat')!
  const rcloneAs = (creds: Record<string, string>, args: string[]) =>
    // same path the app takes: plain S3 with the branch's minted key
    import('../src/docker').then(({ docker }) => docker(['run', '--rm', '--network', main.network,
      '-e', 'RCLONE_CONFIG_G_TYPE=s3', '-e', 'RCLONE_CONFIG_G_PROVIDER=Other',
      '-e', `RCLONE_CONFIG_G_ENDPOINT=${main.s3.AWS_ENDPOINT_URL_S3}`, '-e', 'RCLONE_CONFIG_G_REGION=garage',
      '-e', `RCLONE_CONFIG_G_ACCESS_KEY_ID=${creds.AWS_ACCESS_KEY_ID}`, '-e', `RCLONE_CONFIG_G_SECRET_ACCESS_KEY=${creds.AWS_SECRET_ACCESS_KEY}`,
      'rclone/rclone', ...args]))
  // own bucket readable
  expect((await rcloneAs(main.s3, ['ls', `g:${main.bucket}`])).toString()).toContain('hello.txt')
  // foreign bucket: denied
  await expect(rcloneAs(main.s3, ['ls', `g:${feat.bucket}`])).rejects.toThrow(/AccessDenied|Forbidden|exit/)
})
