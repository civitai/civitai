import { defineConfig } from 'vitest/config';

// Server-unit tests for the orchestrator-api service (mirrors packages/civitai-auth/vitest.config.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
