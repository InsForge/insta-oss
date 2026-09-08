// Run mode and first-run flags. The daemon injects `window.__INSTA_OSS__` into index.html
// (contract decision 8); the Vite dev server has no daemon shell, so `VITE_INSTA_MODE` stands in.
// Pure: every input is a parameter so the module runs under the root vitest config.

export type RunMode = 'local' | 'server'

export interface Boot {
  mode: RunMode
  /** Server mode before the admin exists: the gate sends every visit to /setup. */
  setupRequired: boolean
  /** What `insta login --api-url` should be told (server: https://api.<domain>). */
  apiUrl: string
  consoleUrl: string
}

export type BootWindow = {
  __INSTA_OSS__?: Partial<Boot> | null
  location?: { origin: string }
}

declare global {
  interface Window { __INSTA_OSS__?: Partial<Boot> | null }
}

function envMode(): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  return meta.env?.VITE_INSTA_MODE
}

function asMode(v: unknown): RunMode {
  return v === 'server' ? 'server' : 'local'
}

/** `window.__INSTA_OSS__` when the daemon served the shell, else the dev fallback (local mode,
 *  no setup, both URLs = the page origin). Missing fields inside an injected object fall back
 *  the same way, so a partial injection never yields `undefined` URLs. */
export function readBoot(
  win: BootWindow | undefined = typeof window === 'undefined' ? undefined : (window as BootWindow),
  fallbackMode: string | undefined = envMode(),
): Boot {
  const origin = win?.location?.origin ?? ''
  const injected = win?.__INSTA_OSS__
  if (injected) {
    return {
      mode: asMode(injected.mode),
      setupRequired: injected.setupRequired === true,
      apiUrl: injected.apiUrl ?? origin,
      consoleUrl: injected.consoleUrl ?? origin,
    }
  }
  return { mode: asMode(fallbackMode), setupRequired: false, apiUrl: origin, consoleUrl: origin }
}
