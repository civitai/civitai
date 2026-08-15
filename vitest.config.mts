import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

// Worker count is UNCAPPED by default — Vitest's own resolution applies untouched (`cpus - 1` in
// run mode, `floor(cpus / 2)` in watch; the browser pool sizes itself at `min(12, cpus - 1)`).
//
// The flat cap of 8 that lived here (#3900) existed because several agents each running a full
// suite at once saturated the box. The dev-server test queue now serialises `test:unit:run` at
// concurrency 1 (#3947), so the unit suite no longer competes with a second copy of itself.
//
// Set `VITEST_MAX_WORKERS=<n>` to size a run. Vitest reads that name itself, in `resolveConfig`,
// per project and AFTER this file — so the value here can only ever agree with it, never clamp it.
// In particular it does NOT respect the browser pool's `min(12, cpus - 1)` default: `getThreadsCount`
// returns `project.config.maxWorkers` unclamped, so a number above 12 raises the Chromium instance
// count past what upstream considers safe rather than lowering it.
//
// A run routed through the dev-server queue does not see the caller's environment at all — the
// daemon spawns it with its own — so cap those with the CLI flag instead, which is forwarded:
// `pnpm run test:unit:run --max-workers=8`.
//
// `undefined` is genuinely identical to omitting the key — every consumer is a truthiness / `??`
// check, and `configDefaults` has no `maxWorkers`.
// (Unrelated but adjacent: `test.poolOptions` was removed in Vitest 4, so `poolOptions.forks.maxForks`
// does nothing apart from logging a deprecation.)
// Read here as well as natively so the knob survives Vitest dropping its own read; today the two
// always resolve to the same number, so this cannot disagree with it.
const envMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? '', 10);
const maxWorkers = Number.isFinite(envMaxWorkers) && envMaxWorkers > 0 ? envMaxWorkers : undefined;
const componentMaxWorkers = maxWorkers;

// `component` runs in its own group. The throw this used to dodge — `groupSpecs` refusing two
// projects that share a group but resolve to different worker counts, reported as
// `Test Files: no tests` rather than as a failure — can no longer happen now that nothing here
// sets a per-project `maxWorkers` the others don't also get. What the group still buys is that a
// bare `vitest run` serialises the browser project against the node one instead of interleaving
// them; keep it for that, not for the throw.
//
// Declared statically below AND re-asserted here, deliberately. Static alone is not enough: a CLI
// `--sequence.*` flag REPLACES `test.sequence` wholesale (cliOverrides is a spread, not a merge)
// and takes `groupOrder` with it. The plugin alone is not enough either: this file is outside
// tsconfig's `include`, so nothing typechecks the hook name — a typo would leave the plugin inert
// and silent. Keeping both means one has to fail before anything breaks.
//
// Known gap, unfixable by pinning: `--sequence.groupOrder=1` moves the OTHER projects onto this
// same value, and no constant can dodge that. No script or workflow passes it.
const COMPONENT_GROUP_ORDER = 1;
const componentGroupOrderPlugin = {
  name: 'civitai:component-group-order',
  configureVitest({ project }: { project: any }) {
    project.config.sequence.groupOrder = COMPONENT_GROUP_ORDER;
  },
};

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
  // `@civitai/flipt` (packages/civitai-flipt) backs src/server/flipt/client.ts, which the
  // feature-flag and image suites pull in. Same story as the others: not symlinked into root
  // node_modules, so without this alias those suites fail to collect.
  'flipt',
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

// Browser-mode (`component` project) alias: stub the native `sharp` module.
// A few `.browser.test.tsx` tests import a Next *page* to render its client shell;
// the page's `getServerSideProps` transitively pulls a server service that does
// `import sharp from 'sharp'`. Next strips that server-only graph from real client
// builds, but Vitest's browser build does not — so esbuild's optimizeDeps scan
// follows the import into sharp and dies bundling its native
// `require('../build/Release/sharp-*.node')`, killing the WHOLE component suite
// before any test runs. (The tests `vi.mock` server-side-helpers, but that is a
// runtime interception and can't stop the build-time static scan.) The `unit`
// (node) project keeps the real sharp. Must precede the `~` entry so it wins.
const componentAlias = [
  { find: /^sharp$/, replacement: path.resolve(__dirname, 'test/stubs/sharp.ts') },
  ...alias,
];

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
    maxWorkers,
    projects: [
      // The nine `packages/*` suites, referenced by their OWN config files rather than
      // re-declared here. Until this line existed, nothing in CI invoked them: the `unit`
      // project's `include` is root-relative (`src/**`, `scripts/**`), and CI runs
      // `vitest run --project unit`, so ~330 tests across nine workspace packages ran only
      // for whoever remembered `pnpm --filter <pkg> test` by hand. That is how the
      // schema-drift detector (#3591) shipped with 81 tests CI never executed.
      //
      // Globbed on the CONFIG FILE, not the directory. A bare `packages/*` glob would also
      // adopt the six packages that have no vitest config, and Vitest would give each a
      // default config whose `include` (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) is not the
      // include those packages were written against.
      //
      // Project names come from each package's `package.json` `name` (`@civitai/auth`,
      // `@civitai/db-schema`, ...), because none of the package configs set `test.name`.
      // That is what `--project '@civitai/*'` selects; see the `test:packages:run` script.
      // Keeping them as separate projects (rather than folding their globs into `unit`)
      // preserves each package's own config — `@civitai/db-queries`, for instance, sources
      // DATABASE_URL from the root `.env` so its DB-backed tier self-skips without one.
      'packages/*/vitest.config.ts',
      'packages/*/vitest.config.mts',
      // The `apps/*` suites, on exactly the same footing and for exactly the same reason:
      // nothing in CI invoked them either. Same CONFIG-FILE glob, same rationale — a bare
      // `apps/*` glob would adopt `event-engine` and `moderator`, which have no vitest
      // config, and hand them a default `include` they were never written against.
      // (`apps/event-engine` does own one test file, but it is a `node:test` suite by
      // deliberate choice — see its header — so Vitest is the wrong runner for it.)
      //
      // Unlike the packages, these set `test.name` themselves (`app:auth`,
      // `app:notifications`, ...) rather than inheriting their `package.json` name. That is
      // load-bearing, not cosmetic: every app is ALSO published as `@civitai/*`
      // (`@civitai/auth-app`, and `@civitai/orchestrator-gateway` with no suffix at all), so
      // on the default naming there is no pattern that selects apps without packages or
      // packages without apps — `--project '@civitai/*'` would silently start sweeping the
      // apps into the "Package unit tests" job. An `app:` prefix keeps the two selectors
      // disjoint and structural. Drop a `name` and that app falls back into the packages
      // bucket; scripts/ci/assert-workspace-suites-ran.mjs fails the apps job when it does.
      'apps/*/vitest.config.ts',
      'apps/*/vitest.config.mts',
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          // `scripts/` is included so the typecheck wrapper's outcome
          // classifier (scripts/typecheck.mjs) is covered — it is the thing that
          // decides whether a run counts as a pass, so it needs a suite of its
          // own rather than a one-off manual check.
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['node_modules', 'tests/**/*'], // Exclude Playwright tests
          setupFiles: ['src/__tests__/setup.ts'],
          // Several unit tests cold-`await import(...)` a large Next API-page / service
          // module graph (mocked I/O, but a real ~9–16s TS transform). With the suite's
          // worker pool saturated, that legitimate cold transform races for CPU and
          // overran the old 10s default — a PASS→FAIL that tracked CI load, not code.
          // 60s absorbs that contention while still bounding a genuine hang (these are
          // mocked-I/O tests; nothing should legitimately approach a minute).
          //
          // 🔴 But do NOT treat this ceiling as the place to solve that cost. A cold
          // `await import(...)` reached from a TEST BODY is charged to that ONE test's
          // budget, so the file's whole transform lands inside a single 60s clock:
          // get-models-raw.transient-503 spent 99.9% of its runtime in one test that
          // way (2726ms of a 2730ms file under a 4-CPU quota) and went red purely on
          // ambient runner speed. Hoist the import to MODULE SCOPE instead — `vi.mock`
          // is hoisted above imports, so the mocks still apply, and the transform then
          // lands in Vitest's COLLECTION phase, which no timeout bounds (Vitest has
          // only testTimeout / hookTimeout / teardownTimeout). Where a module genuinely
          // must load per-suite, a `beforeAll` with an explicit long timeout is the
          // fallback (see prisma-inconsistent-orphan-relations). Raising this number
          // only moves the cliff.
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
        resolve: { alias: componentAlias, dedupe: ['react', 'react-dom'] },
        plugins: [componentGroupOrderPlugin],
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
          include: [
            'next/router',
            'vitest-browser-react',
            'react/jsx-dev-runtime',
            'react/jsx-runtime',
            // `react-dom/server` — used by the SSR→hydrate tests
            // (`*.ssrHydration.browser.test.tsx`) to produce real server HTML and
            // hydrate it. WITHOUT this entry Vite discovers it mid-run and emits a
            // SEPARATE optimized chunk that carries its OWN copy of `react`, so
            // `ReactCurrentDispatcher.current` is null inside it and every hook call
            // during `renderToString` throws
            // `Cannot read properties of null (reading 'useState')` — the dual-React
            // failure the `dedupe` above exists to prevent, arriving through the
            // optimizer rather than through a transitive dependency. Listing it here
            // pre-bundles it in the same pass as `react`/`react-dom`, so all three
            // share one instance.
            'react-dom/server',
          ],
          // `@vitest/browser` seeds optimizeDeps.entries from EVERY `*.browser.test.tsx` file
          // (globTestFiles), not just the one you ran. The review app-listing browser tests
          // (src/tests/pages/apps/review/review-{detail-page,queue-nav}.browser.test.tsx, from
          // #3298 on main) each import their page, which pulls in `createServerSideProps` ->
          // `appRouter` -> app-listing-assets.service.ts's
          // `await import('sharp')`. Those tests `vi.mock` `server-side-helpers` so `sharp` is
          // never evaluated at runtime — but esbuild's static scan follows the import anyway and
          // can't pre-bundle sharp's native binding (a template-literal `require` of a `.node`
          // file), failing the whole component project with "No loader is configured for '.node'
          // files" regardless of which test you targeted. Exclude it; no component test needs it.
          exclude: ['sharp'],
        },
        test: {
          name: 'component',
          maxWorkers: componentMaxWorkers,
          // See componentGroupOrderPlugin — this is the static half. Costs only a bare `vitest run`,
          // which serialises the two projects instead of interleaving them; CI and every script
          // select one project at a time.
          sequence: { groupOrder: COMPONENT_GROUP_ORDER },
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
            // CI installs Playwright's own Chromium into the image (env unset),
            // so it resolves by revision as normal. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
            // is the escape hatch for a host whose browser bundle does not carry the
            // revision this playwright release pins (the NixOS
            // `PLAYWRIGHT_BROWSERS_PATH` case) — it bypasses the revision lookup.
            // The better fix is to point PLAYWRIGHT_BROWSERS_PATH at a bundle whose
            // version EQUALS this repo's `playwright` pin (1.57.x → chromium-1200),
            // rather than moving the pin; see CLAUDE.md "Browser/component tests on
            // NixOS". A mismatch does not say "no browser" — it collects every file
            // and executes none, which reads as a broken suite.
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
