import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

// Mirror the workspace `@civitai/*` package mappings from tsconfig.json `paths` so Vitest
// (which doesn't read tsconfig paths, and these packages aren't symlinked into the root
// node_modules) resolves them the same way the app build does. `@civitai/auth` is omitted —
// it IS symlinked in node_modules and resolves via its own exports map. Subpath regex must come
// before the bare entry so `@civitai/redis/client` doesn't get caught by the bare `@civitai/redis`.
const civitaiWorkspacePkgs = [
  'db-schema',
  'db',
  'redis',
  'clickhouse',
  'axiom',
  'telemetry',
  'brand',
  // `@civitai/notifications` (packages/civitai-notifications) is re-exported by
  // src/server/common/enums.ts; without this alias Vitest can't resolve it and
  // the whole server suite cascades (enums.ts → BlockRegistry undefined → …).
  'notifications',
  // `@civitai/buzz` (packages/civitai-buzz) is imported by
  // src/shared/constants/buzz.constants.ts + src/server/services/buzz.service.ts —
  // both pulled in transitively by blocks.router.ts and model-version.service.ts.
  // Same story as notifications: not symlinked into root node_modules, so without
  // this alias every suite touching the buzz chain fails to collect.
  'buzz',
];
const civitaiAlias = civitaiWorkspacePkgs.flatMap((p) => {
  const src = path.resolve(__dirname, `packages/civitai-${p}/src`).replace(/\\/g, '/');
  return [
    { find: new RegExp(`^@civitai/${p}/(.*)$`), replacement: `${src}/$1` },
    { find: `@civitai/${p}`, replacement: `${src}/index` },
  ];
});

const alias = [{ find: '~', replacement: path.resolve(__dirname, './src') }, ...civitaiAlias];

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
          // Several unit tests cold-`await import(...)` a large Next API-page / service
          // module graph (mocked I/O, but a real ~9–16s TS transform). With the suite's
          // worker pool saturated, that legitimate cold transform races for CPU and
          // overran the old 10s default — a PASS→FAIL that tracked CI load, not code.
          // 60s absorbs that contention while still bounding a genuine hang (these are
          // mocked-I/O tests; nothing should legitimately approach a minute).
          testTimeout: 60000,
          // Same cold-`await import()` graph is paid in some suites' beforeAll/beforeEach
          // (e.g. file-download-lookup, listForModel.behavior). Vitest's default
          // hookTimeout is 10s — too tight for that transform on a saturated CI box — so
          // match testTimeout. Without this a hoisted import flakes the hook instead.
          hookTimeout: 60000,
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
        //
        // On a COLD optimizeDeps cache (every fresh CI/preview run), Vite was
        // discovering `vitest-browser-react` + `react/jsx-dev-runtime` only when
        // `test/component-setup.tsx` first imported them — mid-run — and reloading.
        // The reload tears down the module context while component-setup is still
        // importing `vitest-browser-react`, so that package evaluates OUTSIDE a live
        // vitest runner → "Vitest failed to find the runner" → "Failed to import test
        // file test/component-setup.tsx" → EVERY component test fails to load. (Warm
        // cache hid it: the 2nd local run always passed.) Pre-bundling them here makes
        // the optimize pass happen BEFORE the run starts, so there's no mid-run reload.
        optimizeDeps: {
          include: ['next/router', 'vitest-browser-react', 'react/jsx-dev-runtime', 'react/jsx-runtime'],
        },
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
