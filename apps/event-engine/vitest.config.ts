import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Server-unit tests for the event-engine app (mirrors apps/notifications/vitest.config.ts).
export default defineConfig({
  resolve: {
    alias: [
      // 19 source files import through `@/`. Runtime gets it from `tsconfig-paths/register`
      // and the build from `tsc-alias`; Vitest has neither, so without this the first test of
      // anything but the alias-free `signals.ts` fails at collection with `Cannot find package
      // '@/...'` — which reads as a broken test rather than missing config.
      // Matched with the trailing slash so it cannot swallow `@civitai/*` and friends.
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
    ],
  },
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:event-engine',
    environment: 'node',
    // Deliberately as wide as the CI ledger's own detection regex
    // (scripts/ci/assert-workspace-suites-ran.mjs), which scans the whole package. A test the
    // ledger counts but this glob misses would run nowhere while the job stayed green — the
    // ledger asserts the member is present, not that all of its tests ran.
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // Globbed with a leading `**/` because setting `exclude` REPLACES Vitest's defaults
    // rather than adding to them. Root-anchored patterns would leave a nested `node_modules`
    // — anywhere below the package root — collecting third-party tests into this project.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
