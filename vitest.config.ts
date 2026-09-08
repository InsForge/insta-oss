import { configDefaults, defineConfig } from 'vitest/config'
// forks: each test file gets its own process so state-path overrides don't bleed.
// generous timeouts: integration tests start real Docker containers.
// Docker suites (test/**/*.int.test.ts) run only with RUN_DOCKER_TESTS=1 (CI and the integrator, one
// file at a time); an implementer's `npm test` never starts containers (decision 44).
export default defineConfig({
  test: {
    root: '.', testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks',
    exclude: [...configDefaults.exclude, ...(process.env.RUN_DOCKER_TESTS ? [] : ['test/**/*.int.test.ts'])],
  },
})
