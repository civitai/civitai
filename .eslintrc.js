// The custom `no-io-in-transaction` rule lives in ./eslint-local-rules.js and
// is loaded via the `eslint-plugin-local-rules` devDependency.
//
// Keep `eslint-config-next` on 15.x until we migrate to ESLint 9 + flat config.
// eslint-config-next 16 is flat-config-only (peer `eslint >=9`); extending it
// from eslintrc makes @eslint/eslintrc reject it and then crash formatting the
// error ("Converting circular structure to JSON"), so lint silently never runs.
// Enforced by the `eslint-config-next: "15"` entry in package.json `pnpm.overrides`.
const noDirectPgPool = require('./eslint-no-direct-pg-pool.cjs');

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'local-rules'],
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended', // lightweight rules (no type info)
    'plugin:tailwindcss/recommended',
    // "plugin:import/typescript",
    'prettier',
  ],
  settings: {
    // eslint-config-next 15's no-html-link-for-pages rule can't auto-detect the
    // pages dir in this layout (src/pages + an src/app stub) and throws
    // "path argument must be undefined". Pointing the plugin at the project root
    // lets it resolve src/pages correctly.
    next: {
      rootDir: __dirname,
    },
    // "import/resolver": {
    //   // You will also need to install and configure the TypeScript resolver
    //   // See also https://github.com/import-js/eslint-import-resolver-typescript#configuration
    //   "typescript": true,
    //   "node": true,
    // },
  },
  rules: {
    // Flags awaited external I/O inside a Prisma interactive $transaction
    // callback (blows the txn timeout budget). See eslint-local-rules.js.
    // 'warn' (not 'error') — surfaces in the editor / `next lint` as a guardrail
    // without failing lint or the build; escalate to 'error' once the team is
    // ready to gate on it.
    'local-rules/no-io-in-transaction': 'warn',

    // readMetadata/parseGenerationText without `{ plugins: [civitai()] }`
    // type-check clean and silently degrade: madeOnSite false, on-site formats
    // undetected, resources unresolved. Plugin-independent exports
    // (copyMetadata, embedMetadata, types) stay importable. Covers the /image
    // and /node subpaths too (they re-export the same bare readers); a dynamic
    // `await import(...)` is not caught — don't do that.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@civitai/generation-metadata',
            importNames: ['readMetadata', 'parseGenerationText'],
            message:
              'Silently loses civitai semantics without the plugin — use ~/utils/metadata (ExifParser / parsePromptMetadata), or readCivitaiMetadata from @civitai/generation-metadata/civitai.',
          },
          {
            name: '@civitai/generation-metadata/image',
            importNames: ['readMetadata', 'parseGenerationText'],
            message:
              'Silently loses civitai semantics without the plugin — use ~/utils/metadata (ExifParser / parsePromptMetadata), or readCivitaiMetadata from @civitai/generation-metadata/civitai.',
          },
          {
            name: '@civitai/generation-metadata/node',
            importNames: ['readMetadataFromFile'],
            message:
              'Plugin-less by default — read the file yourself and use readCivitaiMetadata from @civitai/generation-metadata/civitai, or pass plugins explicitly.',
          },
        ],
      },
    ],

    // Flags a `vi.mock('~/utils/trpc', () => ({ ... }))` whose factory hand-writes
    // the module instead of spreading the real one via `importOriginal`. A
    // wholesale factory breaks the whole test FILE the day the module gains an
    // export it omits — and a file that fails to load collects 0 tests rather
    // than failing an assertion, so nothing turns red. See eslint-local-rules.js
    // for the full write-up and the canonical fix.
    //
    // Deliberately scoped to `~/utils/trpc` (the module with the widest
    // transitive reach and the one that actually bit us) rather than every
    // wholesale mock in the repo: mocking a narrow leaf module wholesale is a
    // normal, safe thing to do, and flagging it would make the rule noisy enough
    // to get switched off. Extend `modules` if another hub module starts biting.
    //
    // 'error', NOT 'warn' — unlike no-io-in-transaction above, and deliberately.
    // The severity has to be read against .github/workflows/lint.yml, which
    // splits ESLint by how the PR touched the file:
    //
    //   ADDED files    -> BLOCKING, errors only, no --max-warnings
    //                     (lint.yml, "ESLint (added files)": no
    //                      continue-on-error, no --max-warnings)
    //   MODIFIED files -> report-only, continue-on-error: true
    //                     (lint.yml, "ESLint (modified files, report-only)")
    //
    // At 'warn' this rule gates NOTHING anywhere: the added-files step ignores
    // warnings by design (the repo carries ~3,470 of them), so a brand-new
    // browser test with a wholesale trpc mock merges green — which is precisely
    // the authoring path the rule exists to close.
    //
    // At 'error' the blast radius on the pre-existing backlog is ZERO: all 65
    // remaining offenders are pre-existing files, so a PR touching one reaches
    // only the report-only modified-files step. Nothing else in CI runs a
    // whole-src lint (`pnpm lint` is not invoked by any workflow, and
    // .husky/pre-push runs typecheck only, and only on `main`). The rule can
    // therefore only block a NEWLY ADDED file — the one case where "fix it
    // before it merges" is both cheap and correct.
    //
    // One exception to "the backlog only ever reaches the report-only step":
    // `--diff-filter=A` sees a MOVED file as added when git's rename detection
    // misses it (a move plus edits below the ~50% similarity threshold
    // decomposes into A + D). Relocating a backlog file with substantial edits
    // can therefore land it in the blocking step. Fixing the factory at that
    // point is the right outcome, but it is a real cost, not zero.
    //
    // Scope note: the check is proof-based, so an exotic-but-safe factory it
    // cannot walk is reported (`unprovableMock`) rather than assumed safe.
    // That is the intended direction: a false positive costs one disable
    // comment, a false negative costs a silently-empty test suite. The known
    // false-positive shapes are listed in eslint-local-rules.js so a blocked
    // author can recognise their own and reach for a disable comment.
    // `modules` is a CURATED registry, not the whole hazard: the rule only looks
    // at modules named here, so a module absent from this list is not "safe", it
    // is UNWATCHED. That is not hypothetical — `~/utils/trpc` was the only entry
    // when the identical defect landed on `~/components/Dialog/RoutedDialogLink`
    // (#4364 added a `triggerRoutedDialog` importer three files away from a
    // factory that listed only `RoutedDialogLink`; the carousel suite died at
    // import and collected 0 tests for ~17h, reported as `Tests 2062 passed`).
    //
    // Add a module here once its wholesale mocks are converted to the
    // `importOriginal` spread — the entry is only free while the site count is
    // low. Measured on this tree: 62 modules are wholesale-mocked somewhere in
    // the browser suite with at least one REAL export omitted, over 329 call
    // sites, and `eslint src/**/*.browser.test.tsx` already reports 52 files
    // violating this rule for `~/utils/trpc` alone. Those persist because the
    // ESLint gate in .github/workflows/lint.yml blocks only ADDED files; the
    // modified-files pass is `continue-on-error: true`. So widening this list
    // holds NEW browser tests to the pattern and annotates the rest — it does
    // not retroactively fix them.
    //
    // THE THREE ENTRIES BELOW WERE PICKED BY MEASUREMENT, NOT BY MOCK VOLUME.
    // The hazard is a wide export surface reached by many `src/` modules: any
    // one of those importers landing in a test's graph kills the whole FILE. So
    // the admission test is three conditions, all of which must hold:
    //
    //   (a) >= 15 exported bindings   — a surface wide enough that a one-key
    //       factory is a landmine rather than a complete stand-in;
    //   (b) >= 25 non-test `src/` importers — enough reach that some importer
    //       plausibly lands in an unrelated suite's module graph;
    //   (c) ZERO files violating this rule today — the entry must annotate
    //       nothing retroactively, so no pre-existing file goes newly red.
    //
    // Enumerated (not sampled) over all 501 `~/`-specifiers any `src/` test
    // wholesale-mocks: 27 clear (a)+(b), and exactly 3 of those also clear (c).
    // Those 3 are listed. The rest fail ONLY on (c) and are deliberately left
    // out rather than baselined — e.g. `~/server/common/constants` (97 exports,
    // 352 importers) has 14 existing violators, `~/server/services/buzz.service`
    // (37/61) has 110. They are the NEXT candidates, each gated behind
    // converting its own violators first.
    //
    // Volume is explicitly NOT the criterion, and the counterexample matters:
    // `~/hooks/useCurrentUser` is one-key-mocked by 108 files and is harmless,
    // because it exports 2 things — a factory naming both IS the whole module.
    // Listing it would turn ~108 files red to guard nothing.
    //
    //   module                                        exports  src importers  mocked by
    //   ~/shared/data-graph/generation/config/workflows    27        32           1
    //   ~/components/Image/image.utils                     17        29           1
    //   ~/components/Sticker/sticker.util                  16        25           5
    //
    // `image.utils` is the worked example this list gap was found through: #4450
    // added `ownContentPickerFilters` and had `remix-gallery.utils` import it,
    // and `RemixGallerySubmitModal.browser.test.tsx`'s one-key factory then took
    // the whole file out at collection — `Tests no tests`, 2150 others passing,
    // nothing red (fixed in #4463). All 7 files mocking the three modules above
    // already use the `importOriginal` spread; listing them is what stops the
    // next one from not doing so.
    'local-rules/no-wholesale-module-mock': [
      'error',
      {
        modules: [
          '~/utils/trpc',
          '~/components/Dialog/RoutedDialogLink',
          '~/shared/data-graph/generation/config/workflows',
          '~/components/Image/image.utils',
          '~/components/Sticker/sticker.util',
        ],
      },
    ],

    // The SIBLING of the rule above, one level down: that one guards the MODULE's
    // export surface (does the factory spread `importOriginal`), this one guards
    // the `trpc` CLIENT's procedure surface inside the object the factory
    // returns. A mock can be perfect by the first and broken by the second —
    // #4147 was exactly that, which is why #4178 says the existing rule "has no
    // view" of it. Deliberately a separate rule rather than an extension: the
    // `modules` option above is generic across five modules while this check
    // knows about `trpc` and `makeTrpcProxy` specifically, the two remedies are
    // different ("spread the original" vs "call makeTrpcProxy"), and one disable
    // comment must not switch off both guards. Reasoning in full at the rule.
    //
    // 'error', matching its siblings and for the same reason spelled out below:
    // at 'warn' it would gate nothing, because the only BLOCKING ESLint step in
    // .github/workflows/lint.yml ("ESLint (added files)") runs without
    // --max-warnings — and a brand-new component test is exactly the authoring
    // path this rule exists to close.
    //
    // Blast radius on the existing tree: 201 files report (census of all 220
    // `vi.mock('~/utils/trpc', <inline factory>)` calls in `src/`; the other 19
    // are 8 `new Proxy`, 7 `makeTrpcProxy`, and 4 that override no `trpc` key).
    // 🔴 That cannot become a permanently-red gate, and the reason is the lint
    // LANE's shape rather than this rule's severity: the blocking step lints
    // `--diff-filter=A` paths only, and the modified-file step is
    // `continue-on-error: true`. Nothing lints the full repo in CI — not in
    // GitHub Actions (the eslint job is the only ESLint lane and is
    // `pull_request`-only, diff-vs-base) and not in the in-cluster Tekton
    // pr-check pipeline, which runs no ESLint at all. So a legacy file annotates
    // when touched and blocks nothing; a newly ADDED file is blocked. The 201 are
    // deliberately NOT migrated — migration is a one-line change per file,
    // taken opportunistically when someone touches one. `pnpm lint` locally does
    // cover all of `src/` and will show them.
    'local-rules/no-hand-enumerated-trpc-mock': 'error',

    // `new Pool` / `new pg.Pool` outside @civitai/db. Reasoning in eslint-no-direct-pg-pool.cjs;
    // the allowlist is the override below.
    ...noDirectPgPool,

    // aligns closing brackets for tags
    'react/jsx-closing-bracket-location': ['error', 'line-aligned'],

    // 'import/no-cycle': ['error'],

    // Formatting is owned by `pnpm prettier:check` / `prettier:write`, not by
    // eslint-plugin-prettier. `eslint-config-prettier` (extended above) stays so
    // ESLint's stylistic rules don't fight it.

    // rule tweaks
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }],
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': ['error'],

    'tailwindcss/no-custom-classname': [
      'off',
      {
        whitelist: ['mantine-focus-auto'],
      },
    ],
  },

  overrides: [
    {
      // Services must build their Redis caches LAZILY. A module-scope
      // `createCachedObject(...)` runs on IMPORT, so it needs `createCachedObject`
      // and `REDIS_KEYS.CACHES` to exist at module-evaluation time — which they do
      // not in the ~150 suites that wholesale-mock `~/server/redis/client` and the
      // ~26 that mock `~/server/utils/cache-helpers`. Any of those suites that
      // reaches the service TRANSITIVELY then dies during COLLECTION, and the error
      // names a file the suite never mentions. That is how one eager `capTierCache`
      // took out three model-service suites (57 tests) and turned `Unit tests` red
      // on `main` for every open PR (#3505 / #3506).
      //
      // 'error', matching no-wholesale-module-mock and for the same reason: at
      // 'warn' it gates nothing, because the only BLOCKING ESLint step in
      // .github/workflows/lint.yml ("ESLint (added files)") runs without
      // --max-warnings.
      //
      // Blast radius on the existing tree — 30 module-scope caches exist in total
      // (grep says 29; it misses a wrapped `export const x =\n  createCachedObject(`
      // in caches.ts that the AST finds — the rule is the accurate census):
      //   8 reported here: 7 services (buzz, paid-access, model-file, user,
      //     creator-program, image, bug) + redis/resource-data.redis.ts. 7 once
      //     #3506 lands. Each is one lazy getter away; #3506 is the worked example.
      //  22 in src/server/redis/caches.ts, silenced by a file-level disable AT
      //     that file, with the reasoning written there. It is a real backlog, not
      //     a safe shape — all 22 are keyed off REDIS_KEYS at module scope,
      //     exactly like the capTierCache that broke main, and caches.ts is
      //     imported far more widely than paid-access.service.ts was.
      //
      // The 8th (`bugReportCounter` in bug.service.ts) is a `cachedCounter`, the
      // third cache-helpers factory with this hazard. It is REPORTED, not silenced
      // and not converted here: every other member of the backlog is reported, and
      // converting one of them inside the rule's own PR would change a service
      // export's shape (`bugReportCounter.get` -> `bugReportCounter().get`) in a
      // diff that is otherwise pure lint infrastructure. It gets #3506's treatment
      // in its own change.
      //
      // Two more `cachedCounter` calls live at module scope in src/server/routers/
      // (redeemableCode, research) — outside this override, and left there
      // deliberately: routers are not the shape that took out three suites, and
      // widening the glob is a separate blast-radius decision.
      //
      // All are pre-existing FILES, so a PR touching one reaches only the
      // report-only modified-files step. What the rule can BLOCK is a newly ADDED
      // service or redis module — the case where the three-line lazy fix is
      // cheapest, and the one that grows the backlog.
      //
      // SCOPE: this guards eager cache CONSTRUCTION, not eager `REDIS_KEYS` reads.
      // A bare `const CACHE_KEY = REDIS_KEYS.CACHES.X;` at module scope throws the
      // same collection-time TypeError and is deliberately NOT covered — one exists
      // in scope today (nowpayments.service.ts). Counts and the reasoning are in
      // the rule header in eslint-local-rules.js.
      files: ['src/server/services/**/*.ts', 'src/server/redis/**/*.ts'],
      rules: {
        'local-rules/no-module-scope-cache': 'error',
      },
    },
    {
      // 🔴 THE `/apps/*` CHROME MUST NOT BRANCH A RENDER ON A VIEWPORT/CONTAINER HOOK.
      // The rail/drawer swap is a CSS media query on purpose, so React never learns the
      // breakpoint was crossed and the server markup matches the first client paint.
      // These hooks have no server answer — `useContainerSmallerThan` in particular
      // returns FALSE while `inlineSize === 0`, which is what the server always sees —
      // so branching on one reintroduces the hydration mismatch this surface has already
      // paid for once.
      //
      // SCOPE: deliberately narrow. `useIsMobile` alone appears in 83 files across the
      // repo and most of those are legitimate client-only surfaces, so this is NOT a
      // repo-wide ban; it is switched on for the chrome that is server-rendered and
      // hydration-sensitive. Widen the glob when another surface earns it.
      //
      // Replaces a 250-line hand-rolled source scanner that applied to ONE file and was
      // bypassable in five consecutive audit rounds — see the rule header in
      // eslint-local-rules.js.
      files: [
        'src/components/Apps/AppsPageLayout.tsx',
        'src/components/Apps/AppsRailNav.tsx',
        'src/components/Apps/useAppsNavSections.ts',
        'src/components/Apps/appsRailState.tsx',
        // The App Blocks missing-permissions backstop. Its narrow/wide swap is a
        // CONTAINER QUERY on purpose and must stay one.
        //
        // ⚠️ IT EARNS THE GLOB FOR THE FLASH, NOT FOR HYDRATION, AND THE DISTINCTION IS
        // WHY THIS COMMENT IS LONGER THAN THE ENTRY. This surface is NOT server-rendered:
        // `BlockSlot` loads the chain through `dynamic(..., { ssr: false })`, and the
        // notice's own gate withholds it until the iframe posts `BLOCK_READY`. So the
        // hydration-divergence argument the block comment above makes for the `/apps`
        // chrome genuinely does not reach it, and anyone who checks will find that out.
        // What DOES reach it is a pair of reasons, and they are NOT the same reason for
        // all four hooks — an earlier draft said "the four hooks this rule names are
        // exactly the ones that would [flash]", and that was false:
        //   · CONTAINER hooks flash. `useContainerQuery` returns false while
        //     `inlineSize === 0`, `useContainerSmallerThan` wraps it, and bare
        //     `useIsMobile()` routes to it — so each renders the wrong shape for a frame
        //     and then restructures the bar under a viewer already reading it.
        //   · `useMediaQuery` imported from `@mantine/hooks` flashes too (its default is
        //     `getInitialValueInEffect: true`), but THIS REPO'S WRAPPER DOES NOT — it
        //     passes `false` and reads `matchMedia` synchronously on first render, and
        //     with no SSR pass here that read IS the first paint. It is banned for the
        //     other reason, stated at length on the component: a VIEWPORT query answers
        //     the wrong question for a ~320px sidebar on a desktop.
        'src/components/AppBlocks/BlockConsentNotice.tsx',
      ],
      rules: {
        'local-rules/no-ssr-divergent-media-query': 'error',
      },
    },
    {
      // Browser-mode component tests must not use an http(s) URL as an image
      // source. Nothing serves it to the test browser, so the <img> fires a real
      // `error` event a few ms after mount and the component's own onError
      // fallback destroys it — Mantine 7.17.8's Avatar is `useState(!src)` +
      // `onError -> setError(true)`, measured at ~11 ms from mount to swap. Any
      // "the <img> exists" assertion against such a fixture is racing that
      // window: green locally, intermittently red on a loaded CI box. It sat red
      // on `main` across five PRs before #3551, and the data: URI that fixed it
      // was a second copy of one another test file already had — the convention
      // existed and was invisible. Hence a rule, and hence the single shared
      // `LOADABLE_IMAGE_DATA_URI` in test/component-setup.tsx.
      //
      // 'error', matching no-wholesale-module-mock / no-module-scope-cache and
      // for the same reason spelled out above: the only BLOCKING ESLint step in
      // .github/workflows/lint.yml ("ESLint (added files)") runs without
      // --max-warnings, so at 'warn' this would gate nothing — and a brand-new
      // browser test is exactly the authoring path the rule exists to close.
      //
      // Blast radius on the existing tree is bounded and, by lint.yml's split,
      // zero in the blocking step TODAY — with two named caveats, because
      // "zero" is not the same as "permanently zero":
      //   1. `--diff-filter=A` classifies a rename-with-heavy-edit as ADDED, so
      //      MOVING one of the 5 backlog files lands it in the BLOCKING step.
      //      Same caveat the sibling rule documents at the top of this file.
      //   2. lint.yml's own header records that the report-only steps are
      //      planned to flip to blocking once the backlog clears. On that day
      //      these 16 sites block anyone touching those 5 files. The debt is
      //      small and mechanical (9 distinct URLs, nearly all
      //      'https://cdn/x.png' -> LOADABLE_IMAGE_DATA_URI).
      // Population measured by instrumenting all 117
      // *.browser.test.tsx files with a document-level capture listener for
      // <img> `error` events: 14 distinct external image URLs really do mount as
      // broken images today, across 6 files. The rule reports 16 sites in 5
      // files, ALL pre-existing, so a PR touching one reaches only the
      // report-only modified-files step. (The 6th file, AppListingCard, is fixed
      // in this change: its positive assertion uses the shared fixture and its
      // deliberate broken-cover test carries a disable comment with a reason.)
      // They are latent, not harmless — each becomes a flake the moment someone
      // adds an <img> assertion beside it, which is what happened to
      // AppBlockChrome.
      //
      // Scope is deliberately narrow so it cannot reach a non-image URL: the
      // literal must be http(s) AND sit in an image-source position, where the
      // ambiguous `src` additionally has to prove it is an image (file
      // extension, or an <img>-family JSX element). That is what keeps
      // OnsiteReviewModal's `iframe: { src: 'https://example.com/block' }` and
      // AgentReviewChat's markdown `![tracking](https://example.com/pixel.png)`
      // clean — neither can mount an <img> from a fixture. Full reasoning, the
      // key list, and the escape hatch are in eslint-local-rules.js.
      files: ['**/*.browser.test.tsx'],
      rules: {
        'local-rules/no-unloadable-image-fixture': 'error',
      },
    },
    {
      // A cursor fake that never returns a terminal cursor makes a reverted bound an
      // infinite microtask loop, which `testTimeout` cannot interrupt — CI hangs instead
      // of failing. Test files only: production paging code is bounded by the server,
      // not by itself. Reasoning and the escape hatch are in eslint-local-rules.js.
      files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
      rules: {
        'local-rules/no-unbounded-paging-fake': 'error',
      },
    },
    {
      // Where a direct pg Pool is allowed (see eslint-no-direct-pg-pool.cjs). Tests and scripts are
      // short-lived. The auth hub's pool is deliberately standalone, so it must attach the same
      // listeners itself.
      files: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        'scripts/**',
        'apps/*/scripts/**',
        'apps/auth/src/lib/server/db/db.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],

  // No type-aware linting: `parserOptions.project` costs ~40s of program build plus
  // ~2.3s/file (2h40m across the repo). If a type-aware rule is ever worth that, add
  // an `overrides` entry scoped to the narrowest possible file set.
};
