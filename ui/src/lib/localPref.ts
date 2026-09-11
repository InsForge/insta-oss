// A localStorage-backed preference as React state (the console's lib/hooks/use-local-pref.ts):
// useSyncExternalStore, so every caller of one key shares it, across tabs too. Writes notify
// same-tab subscribers (localStorage's own event only fires cross-tab). A browser that blocks site
// data makes the read throw; that is caught, so the chrome never takes the page down.

import { useCallback, useSyncExternalStore } from 'react'

const listeners = new Map<string, Set<() => void>>()

function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => listener())
}

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function useLocalPref(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    useCallback((onChange: () => void) => {
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(onChange)
      window.addEventListener('storage', onChange)
      return () => {
        set.delete(onChange)
        window.removeEventListener('storage', onChange)
      }
    }, [key]),
    () => readLocal(key),
    () => null,
  )

  const setValue = useCallback((next: string | null) => {
    try {
      if (next === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, next)
    } catch {
      // Storage blocked or full: the choice just won't survive a reload.
    }
    emit(key)
  }, [key])

  return [value, setValue]
}

/** A boolean preference stored as "1"/"0". */
export function useLocalFlag(key: string): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = useLocalPref(key)
  const setFlag = useCallback((next: boolean) => setRaw(next ? '1' : '0'), [setRaw])
  return [raw === '1', setFlag]
}
