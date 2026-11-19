import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Compiles the `.svelte` / `.svelte.ts` files the Buzz-mode tests import.
  plugins: [svelte()],
  // This config does not load the SvelteKit plugin, so `$lib` and `$env` need aliasing by hand.
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      '$env/dynamic/private': fileURLToPath(new URL('./src/test/env.mock.ts', import.meta.url)),
    },
  },
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:training-studio',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
