import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: node-env unit tests over plain modules, no SvelteKit
// pipeline needed. `name` is required — see the `apps/*` note in the root vitest.config.mts.
export default defineConfig({
  test: {
    name: 'app:creator-studio',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
