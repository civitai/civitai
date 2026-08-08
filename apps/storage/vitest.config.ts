import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:storage',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
