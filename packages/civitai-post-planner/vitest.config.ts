import { defineConfig } from 'vitest/config';

// The root config globs this file into its project list; the project name comes from package.json
// (`@civitai/post-planner`), which `--project '@civitai/*'` selects. The root treats the file as ONE
// project and ignores any `projects` declared here (measured: a nested browser project was
// collected under node with the default include), so the browser suite has its own config,
// vitest.browser.config.ts, which the root glob does not pick up.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
  },
});
