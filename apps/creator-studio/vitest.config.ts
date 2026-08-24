import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: node-env unit tests over plain modules, no SvelteKit
// pipeline needed. `name` is required — see the `apps/*` note in the root vitest.config.mts.
export default defineConfig({
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
    // Pinned because the sale-budget tests assert UTC behaviour — a sale's budget month, and the
    // inclusive last day, are deliberately UTC so the creator, this form and the server agree. On a
    // UTC runner those assertions pass whether or not the code uses UTC at all, so CI would go green
    // over a local-time regression that only shows up on someone's machine.
    env: { TZ: 'America/Denver' },
  },
});
