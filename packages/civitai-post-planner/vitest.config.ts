import { defineConfig } from 'vitest/config';

// The root config globs `packages/*/vitest.config.ts` into its project list; the project name comes
// from package.json (`@civitai/post-planner`), which `--project '@civitai/*'` selects.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
