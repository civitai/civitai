// The custom `no-io-in-transaction` rule lives in ./eslint-local-rules.js and
// is loaded via the `eslint-plugin-local-rules` devDependency.
//
// Keep `eslint-config-next` on 15.x until we migrate to ESLint 9 + flat config.
// eslint-config-next 16 is flat-config-only (peer `eslint >=9`); extending it
// from eslintrc makes @eslint/eslintrc reject it and then crash formatting the
// error ("Converting circular structure to JSON"), so lint silently never runs.
// Enforced by the `eslint-config-next: "15"` entry in package.json `pnpm.overrides`.
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
    'local-rules/no-wholesale-module-mock': ['error', { modules: ['~/utils/trpc'] }],

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
      // Blast radius on the existing tree — 29 module-scope caches exist in total
      // (grep says 28; it misses a wrapped `export const x =\n  createCachedObject(`
      // in caches.ts that the AST finds — the rule is the accurate census):
      //   7 reported here: 6 services (buzz, paid-access, model-file, user,
      //     creator-program, image) + redis/resource-data.redis.ts. 6 once #3506
      //     lands. Each is one lazy getter away; #3506 is the worked example.
      //  22 in src/server/redis/caches.ts, silenced by a file-level disable AT
      //     that file, with the reasoning written there. It is a real backlog, not
      //     a safe shape — all 22 are keyed off REDIS_KEYS at module scope,
      //     exactly like the capTierCache that broke main, and caches.ts is
      //     imported far more widely than paid-access.service.ts was.
      //
      // All are pre-existing FILES, so a PR touching one reaches only the
      // report-only modified-files step. What the rule can BLOCK is a newly ADDED
      // service or redis module — the case where the three-line lazy fix is
      // cheapest, and the one that grows the backlog.
      files: ['src/server/services/**/*.ts', 'src/server/redis/**/*.ts'],
      rules: {
        'local-rules/no-module-scope-cache': 'error',
      },
    },
  ],

  // No type-aware linting: `parserOptions.project` costs ~40s of program build plus
  // ~2.3s/file (2h40m across the repo). If a type-aware rule is ever worth that, add
  // an `overrides` entry scoped to the narrowest possible file set.
};
