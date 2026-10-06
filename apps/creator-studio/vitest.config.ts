import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: node-env tests with no SvelteKit pipeline. The svelte plugin only
// compiles .svelte, so a test can server-render a page's static markup (see docs/svelte-app-standard.md).
// `name` is required — see the `apps/*` note in the root vitest.config.mts.
export default defineConfig({
  plugins: [svelte()],
  // SvelteKit resolves `$lib` through its own plugin, which this config deliberately doesn't load, so a
  // suite over a module that imports `$lib/...` fails to collect without this.
  resolve: {
    alias: {
      $lib: path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src/lib'),
    },
  },
  test: {
    name: 'app:creator-studio',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['src/test/setup.ts'],
    // Pinned because the sale-budget tests assert UTC behaviour — a sale's budget month, and the
    // inclusive last day, are deliberately UTC so the creator, this form and the server agree. On a
    // UTC runner those assertions pass whether or not the code uses UTC at all, so CI would go green
    // over a local-time regression that only shows up on someone's machine.
    env: { TZ: 'America/Denver' },
  },
});
