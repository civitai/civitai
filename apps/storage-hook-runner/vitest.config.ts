import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:storage-hook-runner',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Real worker_threads and real WASM instances; the slowest case (a native allocation stall cut
    // by the backstop) is bounded well under this.
    testTimeout: 30_000,
  },
});
