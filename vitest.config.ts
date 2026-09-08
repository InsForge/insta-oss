import { configDefaults, defineConfig } from 'vitest/config'
// forks: each test file gets its own process so state-path overrides don't bleed.
// generous timeouts: integration tests start real Docker containers.
// Docker suites (test/**/*.int.test.ts) run only with RUN_DOCKER_TESTS=1 (CI and the integrator, one
// file at a time); an implementer's `npm test` never starts containers (decision 44).
// The dashboard's pure helpers (ui/src/lib) are unit-tested from this root config too (plan 07):
// no second vitest install under ui/.
export default defineConfig({
  test: {
    root: '.', testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks',
    include: ['test/**/*.test.ts', 'ui/src/lib/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(process.env.RUN_DOCKER_TESTS ? [] : ['test/**/*.int.test.ts'])],
  },
})
