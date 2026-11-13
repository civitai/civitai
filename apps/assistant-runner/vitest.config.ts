import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:assistant-runner',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // The Postgres-backed suites start DBOS and child runner processes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
