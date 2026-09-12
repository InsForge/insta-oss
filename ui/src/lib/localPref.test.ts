import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocal, writeLocal } from './localPref'

// The in-memory fallback is module state by design (one store per page), so each test uses its own
// key rather than resetting a singleton through a test-only export.

function stub(localStorage: object): void {
  vi.stubGlobal('window', { localStorage })
}

const throwing = {
  getItem() { throw new Error('blocked') },
  setItem() { throw new Error('blocked') },
  removeItem() { throw new Error('blocked') },
}

afterEach(() => { vi.unstubAllGlobals() })

describe('localPref with storage BLOCKED', () => {
  // A private window, blocked or cleared site data: both getItem and setItem throw. The chrome
  // must keep working, AND the choice must still apply to the page it was made on — re-reading
  // `null` there meant the theme toggle did nothing at all.
  it('holds the written value in memory instead of losing it', () => {
    stub(throwing)
    expect(readLocal('blocked-theme')).toBe(null)
    writeLocal('blocked-theme', 'dark')
    expect(readLocal('blocked-theme')).toBe('dark')
    writeLocal('blocked-theme', null)
    expect(readLocal('blocked-theme')).toBe(null)
  })

  it('keeps keys independent', () => {
    stub(throwing)
    writeLocal('ind-theme', 'dark')
    writeLocal('ind-sidebar', '0')
    expect(readLocal('ind-theme')).toBe('dark')
    expect(readLocal('ind-sidebar')).toBe('0')
    expect(readLocal('ind-unset')).toBe(null)
  })
})

describe('localPref with a FULL store', () => {
  // The case that separates "prefer the fallback" from "fall back only when the read throws": a
  // quota error makes setItem throw while getItem keeps answering with the stale value.
  it('returns the new choice, not the value the failed write was meant to replace', () => {
    const store = new Map<string, string>([['full-theme', 'light']])
    stub({
      getItem: (k: string) => store.get(k) ?? null,
      setItem() { throw new Error('QuotaExceededError') },
      removeItem() { throw new Error('QuotaExceededError') },
    })
    expect(readLocal('full-theme')).toBe('light')
    writeLocal('full-theme', 'dark')
    expect(readLocal('full-theme')).toBe('dark')
  })

  it('reconciles once storage accepts a write again', () => {
    let full = true
    const store = new Map<string, string>([['rec-theme', 'light']])
    stub({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { if (full) throw new Error('full'); store.set(k, v) },
      removeItem: (k: string) => { if (full) throw new Error('full'); store.delete(k) },
    })
    writeLocal('rec-theme', 'dark')
    expect(readLocal('rec-theme')).toBe('dark')
    full = false
    writeLocal('rec-theme', 'system')
    expect(store.get('rec-theme')).toBe('system')
    // The in-memory entry is gone, so storage is the source again.
    store.set('rec-theme', 'light')
    expect(readLocal('rec-theme')).toBe('light')
  })
})

describe('localPref with storage WORKING', () => {
  it('reads through to localStorage and keeps no in-memory copy', () => {
    const store = new Map<string, string>()
    stub({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
    writeLocal('ok-theme', 'light')
    expect(readLocal('ok-theme')).toBe('light')
    expect(store.get('ok-theme')).toBe('light')
    // Storage is the source: a value set behind our back is what the next read returns.
    store.set('ok-theme', 'dark')
    expect(readLocal('ok-theme')).toBe('dark')
    writeLocal('ok-theme', null)
    expect(readLocal('ok-theme')).toBe(null)
  })
})
