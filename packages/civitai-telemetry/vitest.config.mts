import { defineConfig } from 'vitest/config';

// Adopted by the root config's `packages/*/vitest.config.mts` glob. No `test.name`, so
// the Vitest project name is this package's `package.json` name (`@civitai/telemetry`) —
// which is what `--project '@civitai/*'` selects. See the root vitest.config.mts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
