import { defineConfig } from 'vitest/config';

// Server-unit tests for the orchestrator-gateway service (mirrors packages/civitai-auth/vitest.config.ts).
export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:orchestrator-gateway',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
