import { defineConfig } from 'vitest/config';

// Same shape as the other `packages/*` configs. The root config globs
// `packages/*/vitest.config.ts` into its project list, so adding this file is what makes this
// package's suite run at all — without it the tests exist on disk and nothing invokes them.
// The project name comes from `package.json` (`@civitai/shared`), which is what
// `--project '@civitai/*'` (pnpm test:packages:run) selects.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
