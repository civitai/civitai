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
  ignorePatterns: ['.svelte-kit/', 'build/', 'node_modules/', '*.cjs'],
  rules: {
    // Matches the root config's posture: `any` is pervasive here and failing on it would hold new
    // files to a stricter bar than anything already merged.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
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
