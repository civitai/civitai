import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This config does not load the SvelteKit plugin, so `$lib` needs aliasing by hand.
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
  },
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:training-studio',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
