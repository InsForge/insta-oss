// A localStorage-backed preference as React state (the console's lib/hooks/use-local-pref.ts):
// useSyncExternalStore, so every caller of one key shares it, across tabs too. Writes notify
// same-tab subscribers (localStorage's own event only fires cross-tab). A browser that blocks site
// data makes the read throw; that is caught, so the chrome never takes the page down.

import { useCallback, useSyncExternalStore } from 'react'

const listeners = new Map<string, Set<() => void>>()

// What a write held when localStorage refused it (a private window, blocked site data, a full
// quota). Without this the catch below swallowed the write and the snapshot re-read `null`, so the
// theme and sidebar toggles did nothing at all, rather than the "works until reload" this file
// promised. Only written on failure, so a working localStorage is still the single source.
const fallback = new Map<string, string | null>()

function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => listener())
}

export function readLocal(key: string): string | null {
  // The fallback wins whenever it holds this key, not only when the read throws. A FULL store is
  // the case that separates them: `setItem` throws on quota while `getItem` keeps working, so
  // consulting storage first returned the value the failed write was meant to replace. An entry
  // exists only while a write is unpersisted; a later write that lands clears it, which is how
  // storage recovering reconciles.
  if (fallback.has(key)) return fallback.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Drop the unpersisted value for `key`, so the shared store is the source again. Exported for the
 *  storage-event path and for tests; a write that lands clears it too. */
export function clearFallback(key: string): void {
  fallback.delete(key)
}

/** Store a preference and tell this tab's subscribers. */
export function writeLocal(key: string, next: string | null): void {
  try {
    if (next === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, next)
    fallback.delete(key)
  } catch {
    // Storage blocked or full: hold it in memory so the choice still applies to this page. It
    // just won't survive a reload.
    fallback.set(key, next)
  }
  emit(key)
}

export function useLocalPref(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    useCallback((onChange: () => void) => {
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(onChange)
      // A `storage` event is ANOTHER tab writing the same key, and that write is authoritative: it
      // landed in the shared store, while our fallback entry exists only because ours did not.
      // Holding onto it past that point pinned this tab to a value the user had since changed or
      // cleared elsewhere, for as long as the page stayed open.
      const onStorage = (e: StorageEvent) => {
        if (e.storageArea === window.localStorage && (e.key === null || e.key === key)) clearFallback(key)
        onChange()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        set.delete(onChange)
        window.removeEventListener('storage', onStorage)
      }
    }, [key]),
    () => readLocal(key),
    () => null,
  )

  const setValue = useCallback((next: string | null) => { writeLocal(key, next) }, [key])

  return [value, setValue]
}

/** A boolean preference stored as "1"/"0". */
export function useLocalFlag(key: string): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = useLocalPref(key)
  const setFlag = useCallback((next: boolean) => setRaw(next ? '1' : '0'), [setRaw])
  return [raw === '1', setFlag]
}
