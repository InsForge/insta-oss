import { describe, expect, it } from 'vitest'
import { instanceLabel, labelMatches } from './instanceLabels'

describe('instanceLabel', () => {
  it('reduces a compute container to its group and the default database to postgres', () => {
    expect(instanceLabel('io-demo-main-app-worker')).toBe('worker')
    expect(instanceLabel('io-demo-main-pg')).toBe('postgres')
    expect(instanceLabel(undefined)).toBe('')
  })

  it('leaves an extra database container raw, which is what labelMatches then keys on', () => {
    expect(instanceLabel('io-demo-main-pg-analytics')).toBe('io-demo-main-pg-analytics')
    expect(instanceLabel('io-demo-main-rd-cache')).toBe('io-demo-main-rd-cache')
  })
})

describe('labelMatches', () => {
  it('matches a compute group exactly', () => {
    expect(labelMatches('api', 'api')).toBe(true)
    expect(labelMatches('worker', 'api')).toBe(false)
  })

  // The bug: a bare "ends with -<name>" made one app's logs and metrics include another's
  // whenever the names were suffixes of each other.
  it('does NOT treat a compute group as another whose name it ends with', () => {
    expect(labelMatches('worker-api', 'api')).toBe(false)
    expect(labelMatches('api', 'worker-api')).toBe(false)
  })

  it('matches database containers on their own prefix', () => {
    expect(labelMatches('io-demo-main-pg-analytics', 'analytics')).toBe(true)
    expect(labelMatches('io-demo-main-rd-cache', 'cache')).toBe(true)
    expect(labelMatches('io-demo-main-my-orders', 'orders')).toBe(true)
    expect(labelMatches('io-demo-main-mo-events', 'events')).toBe(true)
  })

  it('still maps the default database, which reports as postgres, to the service named db', () => {
    expect(labelMatches('postgres', 'db')).toBe(true)
    expect(labelMatches('postgres', 'analytics')).toBe(false)
  })
})
