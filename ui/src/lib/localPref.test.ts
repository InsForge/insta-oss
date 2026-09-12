import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocal, writeLocal } from './localPref'

// A browser that blocks site data (a private window, cleared or blocked storage, a full quota)
// makes both getItem and setItem throw. The chrome must keep working, AND the choice must still
// apply to the page it was made on — re-reading `null` there meant the theme toggle did nothing.
function blockStorage(): void {
  vi.stubGlobal('window', {
    localStorage: {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
      removeItem() { throw new Error('blocked') },
    },
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('localPref with storage blocked', () => {
  it('holds the written value in memory instead of losing it', () => {
    blockStorage()
    expect(readLocal('theme')).toBe(null)
    writeLocal('theme', 'dark')
    expect(readLocal('theme')).toBe('dark')
    writeLocal('theme', null)
    expect(readLocal('theme')).toBe(null)
  })

  it('keeps keys independent', () => {
    blockStorage()
    writeLocal('theme', 'dark')
    writeLocal('sidebar', '0')
    expect(readLocal('theme')).toBe('dark')
    expect(readLocal('sidebar')).toBe('0')
    expect(readLocal('unset')).toBe(null)
  })
})

describe('localPref with storage working', () => {
  it('reads through to localStorage and drops the in-memory copy', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
        removeItem: (k: string) => { store.delete(k) },
      },
    })
    writeLocal('theme', 'light')
    expect(readLocal('theme')).toBe('light')
    expect(store.get('theme')).toBe('light')
    writeLocal('theme', null)
    expect(readLocal('theme')).toBe(null)
  })
})
