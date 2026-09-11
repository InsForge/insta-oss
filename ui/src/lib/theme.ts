// Light / Dark / System, like the console's account menu. Class-based (`.dark` on <html>), the
// console's convention; the default is dark, as it is there. index.html applies the stored choice
// before first paint so the page never flashes the other theme.

import { useEffect } from 'react'
import { useLocalPref } from './localPref'

export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_KEY = 'insta_theme'
export const DEFAULT_THEME: ThemePreference = 'dark'

export function asTheme(v: string | null): ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT_THEME
}

/** Whether a preference renders dark, given what the OS prefers. Pure, for the tests. */
export function isDark(pref: ThemePreference, systemDark: boolean): boolean {
  return pref === 'dark' || (pref === 'system' && systemDark)
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}

export function applyTheme(pref: ThemePreference): void {
  document.documentElement.classList.toggle('dark', isDark(pref, systemPrefersDark()))
}

export function useTheme(): { theme: ThemePreference; setTheme: (t: ThemePreference) => void } {
  const [raw, setRaw] = useLocalPref(THEME_KEY)
  const theme = asTheme(raw)
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const follow = () => applyTheme('system')
    mq.addEventListener('change', follow)
    return () => mq.removeEventListener('change', follow)
  }, [theme])
  return { theme, setTheme: setRaw }
}
