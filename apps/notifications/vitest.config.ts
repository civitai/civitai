import { defineConfig } from 'vitest/config';

// Server-unit tests for the notifications app (mirrors apps/orchestrator-gateway/vitest.config.ts).
export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:notifications',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
