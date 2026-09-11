import { describe, expect, it } from 'vitest'
import { readBoot } from './mode'

describe('readBoot', () => {
  it('falls back to local mode when window.__INSTA_OSS__ is absent', () => {
    const boot = readBoot({ location: { origin: 'http://127.0.0.1:8080' } }, undefined)
    expect(boot).toEqual({ mode: 'local', setupRequired: false, apiUrl: 'http://127.0.0.1:8080', consoleUrl: 'http://127.0.0.1:8080', alwaysOnDefault: true })
  })

  it('honours the Vite dev fallback mode when nothing is injected', () => {
    expect(readBoot({ location: { origin: 'http://localhost:5173' } }, 'server').mode).toBe('server')
    expect(readBoot({ location: { origin: 'http://localhost:5173' } }, 'nonsense').mode).toBe('local')
  })

  it('passes server flags through from the injected shell', () => {
    const boot = readBoot({
      __INSTA_OSS__: { mode: 'server', setupRequired: true, apiUrl: 'https://api.x.test', consoleUrl: 'https://console.x.test' },
      location: { origin: 'https://console.x.test' },
    }, undefined)
    expect(boot).toEqual({ mode: 'server', setupRequired: true, apiUrl: 'https://api.x.test', consoleUrl: 'https://console.x.test', alwaysOnDefault: true })
  })

  it('fills missing injected fields from the origin and never trusts a foreign mode string', () => {
    const boot = readBoot({ __INSTA_OSS__: { mode: 'cloud' as never }, location: { origin: 'http://h:1' } }, 'server')
    expect(boot).toEqual({ mode: 'local', setupRequired: false, apiUrl: 'http://h:1', consoleUrl: 'http://h:1', alwaysOnDefault: true })
  })

  it('treats an injected null as absent', () => {
    expect(readBoot({ __INSTA_OSS__: null, location: { origin: 'http://h:1' } }, undefined).mode).toBe('local')
  })

  it('runs without a window at all', () => {
    expect(readBoot(undefined, undefined)).toEqual({ mode: 'local', setupRequired: false, apiUrl: '', consoleUrl: '', alwaysOnDefault: true })
  })
})
