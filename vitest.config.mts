import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

const alias = { '~': path.resolve(__dirname, './src') };

// Two Vitest projects sharing one config/runner:
//  - `unit`      = the existing node-env suite, unchanged.
//  - `component` = browser-mode (real Chromium via Playwright) for React
//                  components/widgets. Distinct `.browser.test.tsx` glob so the
//                  unit project never boots a browser (its include is `.test.ts`
//                  only, so `.tsx` is already excluded — the glob is explicit
//                  belt-and-suspenders). See `test/component-setup.tsx`.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['node_modules', 'tests/**/*'], // Exclude Playwright tests
          setupFiles: ['src/__tests__/setup.ts'],
          testTimeout: 10000,
          deps: {
            inline: [/@civitai\/client/],
          },
        },
      },
      {
        // dedupe React so a transitive dep can't pull a second copy — a second
        // React makes `useContext` read a null context and crashes some Mantine
        // components (e.g. @mantine/dropzone) in browser mode, notably on a COLD
        // optimizeDeps cache (fresh CI runs). Canonical fix; protects every
        // component test from this class of dual-React crash.
        resolve: { alias, dedupe: ['react', 'react-dom'] },
        // Pre-bundle deps the component setup mocks/imports so Vitest doesn't
        // discover them mid-run and trigger a "Vite unexpectedly reloaded a
        // test" warning (a flake vector).
        optimizeDeps: { include: ['next/router'] },
        test: {
          name: 'component',
          globals: true,
          include: ['src/**/*.browser.test.tsx'],
          // process-shim MUST come first (no imports) so it runs before any
          // component's module graph reads `process.env` at import time.
          setupFiles: ['test/browser-process-shim.ts', 'test/component-setup.tsx'],
          browser: {
            enabled: true,
            // `--no-sandbox` + `--disable-dev-shm-usage`: required to launch
            // Chromium as root inside the Tekton CI container (node:20 pod runs
            // as UID 0; without --no-sandbox Chromium refuses to start, and the
            // container's small /dev/shm crashes it without --disable-dev-shm-usage).
            // Harmless locally.
            // CI uses Playwright's bundled Chromium (env unset). NixOS can't run
            // that generic binary; point this at a system Chromium, e.g.
            // `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium)`.
            provider: playwright({
              launchOptions: {
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
                ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
                  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
                  : {}),
              },
            }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/server/services/**', 'src/server/jobs/**'],
    },
  },
});
