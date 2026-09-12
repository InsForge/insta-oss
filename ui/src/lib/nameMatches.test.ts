import { describe, expect, it } from 'vitest'
import { nameMatches } from './nameMatches'

describe('nameMatches (type-to-confirm)', () => {
  it('opens only on the exact name, trimmed', () => {
    expect(nameMatches('web', 'web')).toBe(true)
    expect(nameMatches('  web ', 'web')).toBe(true)
    expect(nameMatches('we', 'web')).toBe(false)
    expect(nameMatches('Web', 'web')).toBe(false)
  })

  it('fails closed on a blank name, even for a blank input', () => {
    expect(nameMatches('', '')).toBe(false)
    expect(nameMatches('   ', ' ')).toBe(false)
  })
})
