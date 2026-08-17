import { defineConfig } from 'vitest/config';

// Server-unit tests for the event-engine app (mirrors apps/notifications/vitest.config.ts).
export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:event-engine',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
