// Scoped to this app rather than folded into the repo-root .eslintrc.js: root extends
// `next/core-web-vitals` + the tailwind plugin, neither of which applies to a SvelteKit app, and the
// root config cannot parse `.svelte` at all (@typescript-eslint/parser reads the markup as TS and
// errors). `root: true` stops that config from being inherited here.
//
// Mirrors apps/creator-studio/.eslintrc.cjs deliberately — two SvelteKit apps in one repo linting to
// different rules is a difference nobody chose. Keep them in step.
//
// `.cjs` because package.json sets "type": "module" and eslintrc must be CommonJS.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    extraFileExtensions: ['.svelte'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:svelte/recommended',
  ],
  overrides: [
    {
      files: ['*.svelte'],
      parser: 'svelte-eslint-parser',
      parserOptions: { parser: '@typescript-eslint/parser' },
      rules: {
        // Svelte 5 REQUIRES `let` for `$props()` destructuring — the compiler rewrites the binding and
        // `const` breaks bindable props.
        'prefer-const': 'off',
      },
    },
  ],
  env: { browser: true, node: true, es2022: true },
  // `src/lib/server/moderator-db/` is prisma-kysely output — it carries a type per table in the
  // moderator database, and the ones with no screen yet read as unused.
  ignorePatterns: [
    '.svelte-kit/',
    'build/',
    'node_modules/',
    '*.cjs',
    'src/lib/server/moderator-db/',
  ],
  rules: {
    // Matches the root config's posture: `any` is pervasive here and failing on it would hold new
    // files to a stricter bar than anything already merged.
    '@typescript-eslint/no-explicit-any': 'off',
    // `varsIgnorePattern` as well as args: the codebase destructures values purely to keep them OUT of
    // a `...rest` spread (EdgeVideo absorbs anim/transcode/type/original so they never reach the DOM
    // element), and underscore-prefixing is how that intent is already written.
    // `ignoreRestSiblings` covers the same idiom without the prefix — `({ prompt, ...item }) => item`
    // is an omit, not a forgotten variable.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    // OFF, not because assertions are fine, but because the dominant trigger here is an API that
    // cannot narrow: Kysely's `.$if(cond, (qb) => …)` puts the guard in one argument and the use in
    // another, so `cursor!` inside the callback is forced and provably safe. 15 of the 23 reported
    // were that shape. The handful that were NOT — an optional `selected` set asserted present, a
    // header read twice — were fixed before this went off, so it is not burying them.
    '@typescript-eslint/no-non-null-assertion': 'off',
    // TS resolves types itself and no-undef cannot see them — it reports generics and DOM lib types as
    // undefined globals. Disabling it is typescript-eslint's own documented guidance for TS projects.
    'no-undef': 'off',
    'prefer-const': ['error', { destructuring: 'all' }],
    '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
    // Re-reports Svelte compiler diagnostics, which `pnpm typecheck` (svelte-check) already owns and
    // reports better — including the `state_referenced_locally` warnings this app relies on.
    'svelte/valid-compile': 'off',
  },
};
