import { describe, expect, it } from 'vitest'
import { instanceLabel } from './instanceLabels'

describe('instanceLabel', () => {
  it('reduces a compute container to its group and the default database to postgres', () => {
    expect(instanceLabel('io-demo-main-app-worker')).toBe('worker')
    expect(instanceLabel('io-demo-main-pg')).toBe('postgres')
    expect(instanceLabel(undefined)).toBe('')
  })

  it('leaves an extra database container raw', () => {
    expect(instanceLabel('io-demo-main-pg-analytics')).toBe('io-demo-main-pg-analytics')
    expect(instanceLabel('io-demo-main-rd-cache')).toBe('io-demo-main-rd-cache')
  })

  // Why there is no labelMatches any more: this collision is not resolvable from the label alone.
  // A postgres service NAMED "pg" and the branch's DEFAULT database both reduce to "postgres", so
  // any name-based filter either dropped the named service's own lines or mixed the two together.
  // Scoping happens at the daemon with `?group=` instead.
  it('cannot distinguish a service named pg from the default database, which is why filtering moved to the daemon', () => {
    expect(instanceLabel('io-demo-main-pg-pg')).toBe('postgres')
    expect(instanceLabel('io-demo-main-pg')).toBe('postgres')
  })
})
