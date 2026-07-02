import { defineConfig } from 'vitest/config';

// Server-unit tests for the notifications app (mirrors apps/orchestrator-gateway/vitest.config.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
