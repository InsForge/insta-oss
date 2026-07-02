// Integration (real Docker): branch create copies the data and is isolated from main.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalMinio } from '../src/adapters/storage'

const engine = new Engine(new LocalPostgres(), new DockerCompute(), new LocalMinio())
let projectId = ''
const pg = new LocalPostgres()

const teardown = async () => { try { if (projectId) await engine.destroyProject(projectId) } catch {} }

beforeAll(async () => {
  process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-int-')), 'state.json')
})
afterAll(teardown)

test('branch create copies data and is isolated', async () => {
  const { project } = await engine.createProject('citest')
  projectId = project.id

  await pg.query('citest-main', 'CREATE TABLE notes(id serial primary key, body text);')
  await pg.query('citest-main', "INSERT INTO notes(body) VALUES ('from-main');")

  await engine.createBranch(projectId, 'feat')
  expect(await pg.query('citest-feat', "SELECT count(*) FROM notes WHERE body='from-main';")).toBe('1')

  await pg.query('citest-feat', "INSERT INTO notes(body) VALUES ('from-feat');")
  expect(await pg.query('citest-main', 'SELECT count(*) FROM notes;')).toBe('1') // main unchanged
  expect(await pg.query('citest-feat', 'SELECT count(*) FROM notes;')).toBe('2')
  expect(await pg.query('citest-main', "SELECT count(*) FROM notes WHERE body='from-feat';")).toBe('0')
})
