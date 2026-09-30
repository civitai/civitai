import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// `$lib` is the only SvelteKit alias the tested modules use. `name` must keep the `app:` prefix —
// see the `apps/*` note in the root vitest.config.mts.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  test: {
    name: 'app:training-studio',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
