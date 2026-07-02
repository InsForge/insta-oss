// Integration (real Docker + MinIO): storage branching = bucket copy, isolated.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalMinio } from '../src/adapters/storage'

const storage = new LocalMinio()
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
