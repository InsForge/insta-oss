import { describe, expect, it } from 'vitest'
import type { SecretTree } from '../api'
import { effectiveVariables } from './effectiveVariables'

type Branch = SecretTree['branches'][number]

const branch = (over: Partial<Branch> = {}): Branch => ({
  name: 'main', isDefault: true, services: [], unbound: [], ...over,
})

describe('effectiveVariables', () => {
  it('shows one row per name when the environment shadows the project', () => {
    const tree: SecretTree = { projectWide: ['API_KEY', 'ONLY_PROJECT'], branches: [] }
    const b = branch({ unbound: ['API_KEY', 'ONLY_ENV'] })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'API_KEY')).toHaveLength(1)
    // The environment wins: it is applied after project-wide in engine.envFor.
    expect(rows.find((r) => r.name === 'API_KEY')?.source).toBe('Environment')
    expect(rows.find((r) => r.name === 'ONLY_PROJECT')?.source).toBe('Project')
    expect(rows.find((r) => r.name === 'ONLY_ENV')?.source).toBe('Environment')
  })

  it('lets a secret bound to this group shadow both the project and the environment', () => {
    const tree: SecretTree = { projectWide: ['API_KEY'], branches: [] }
    const b = branch({
      unbound: ['API_KEY'],
      services: [{ type: 'compute', name: 'app', secrets: ['API_KEY'], minted: [] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'API_KEY')).toHaveLength(1)
    expect(rows[0]?.source).toBe('This service')
  })

  it('lets a user secret shadow a minted credential name', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      unbound: ['REDIS_URL'],
      services: [{ type: 'redis', name: 'cache', secrets: [], minted: ['REDIS_URL'] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.filter((r) => r.name === 'REDIS_URL')).toHaveLength(1)
    expect(rows[0]?.source).toBe('Environment')
  })

  it('never carries a secret bound to another compute group', () => {
    const tree: SecretTree = { projectWide: [], branches: [] }
    const b = branch({
      services: [
        { type: 'compute', name: 'app', secrets: ['MINE'], minted: [] },
        { type: 'compute', name: 'worker', secrets: ['THEIRS'], minted: [] },
      ],
    })
    const rows = effectiveVariables(tree, b, { type: 'compute', name: 'app' })
    expect(rows.map((r) => r.name)).toEqual(['MINE'])
  })

  it('shows a non-compute service only what it mints and what is bound to it', () => {
    const tree: SecretTree = { projectWide: ['API_KEY'], branches: [] }
    const b = branch({
      unbound: ['ENV_ONLY'],
      services: [{ type: 'redis', name: 'cache', secrets: ['REDIS_URL', 'TUNING'], minted: ['REDIS_URL'] }],
    })
    const rows = effectiveVariables(tree, b, { type: 'redis', name: 'cache' })
    expect(rows).toEqual([
      { name: 'REDIS_URL', source: 'cache' },
      { name: 'TUNING', source: 'cache' },
    ])
  })

  it('is empty before the tree loads or for a branch that is not in it', () => {
    expect(effectiveVariables(undefined, branch(), { type: 'compute', name: 'app' })).toEqual([])
    expect(effectiveVariables({ projectWide: ['A'], branches: [] }, undefined, { type: 'compute', name: 'app' })).toEqual([])
  })
})
