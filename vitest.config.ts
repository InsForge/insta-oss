import { defineConfig } from 'vitest/config'
// forks: each test file gets its own process so INSTA_OSS_STATE overrides don't bleed.
// generous timeouts: integration tests start real Docker containers.
export default defineConfig({
  test: { root: '.', testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks' },
})
