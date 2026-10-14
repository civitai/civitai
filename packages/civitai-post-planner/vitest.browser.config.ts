// eslint-disable-next-line import/no-extraneous-dependencies -- test tooling, same as the root config
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Browser-mode tests for the element's interactions, in real Chromium like the main app's
// `component` project. Deliberately not `vitest.config.ts`: the root globs that file into the
// packages suite, whose CI job installs no browser. Run with `pnpm run test:browser` in this
// package (or `pnpm --filter @civitai/post-planner test:browser` from the root).
export default defineConfig({
  test: {
    name: 'post-planner-browser',
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      // Same launch flags as the main app's `component` project, for the same CI container.
      provider: playwright({
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
          ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
        },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
