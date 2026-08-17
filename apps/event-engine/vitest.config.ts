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
    include: ['src/**/*.{test,spec}.ts'],
  },
});
