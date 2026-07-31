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
    //   ADDED files    -> BLOCKING, errors only, no --max-warnings (lint.yml:97)
    //   MODIFIED files -> report-only, continue-on-error: true    (lint.yml:125)
    //
    // At 'warn' this rule gates NOTHING anywhere: the added-files step ignores
    // warnings by design (the repo carries ~3,470 of them), so a brand-new
    // browser test with a wholesale trpc mock merges green — which is precisely
    // the authoring path the rule exists to close.
    //
    // At 'error' the blast radius on the pre-existing backlog is ZERO: all 63
    // remaining offenders are pre-existing files, so a PR touching one reaches
    // only the report-only modified-files step. Nothing else in CI runs a
    // whole-src lint (`pnpm lint` is not invoked by any workflow, and
    // .husky/pre-push runs typecheck only, and only on `main`). The rule can
    // therefore only block a NEWLY ADDED file — the one case where "fix it
    // before it merges" is both cheap and correct.
    //
    // Scope note: the check is proof-based, so an exotic-but-safe factory it
    // cannot walk is reported (`unprovableMock`) rather than assumed safe.
    // That is the intended direction: a false positive costs one disable
    // comment, a false negative costs a silently-empty test suite.
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

  // No type-aware linting: `parserOptions.project` costs ~40s of program build plus
  // ~2.3s/file (2h40m across the repo). If a type-aware rule is ever worth that, add
  // an `overrides` entry scoped to the narrowest possible file set.
};
