// Scoped to this app rather than folded into the repo-root .eslintrc.js: root extends
// `next/core-web-vitals` + the tailwind plugin, neither of which applies to a SvelteKit app, and the
// root config can't parse `.svelte` at all (@typescript-eslint/parser reads the markup as TS and
// errors). `root: true` stops that config from being inherited here.
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
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:svelte/recommended'],
  overrides: [
    {
      files: ['*.svelte'],
      parser: 'svelte-eslint-parser',
      parserOptions: { parser: '@typescript-eslint/parser' },
      rules: {
        // Svelte 5 REQUIRES `let` for `$props()` destructuring — the compiler rewrites the binding and
        // `const` breaks bindable props. prefer-const flags every prop in every component (118 of them).
        'prefer-const': 'off',
      },
    },
  ],
  env: { browser: true, node: true, es2022: true },
  ignorePatterns: ['.svelte-kit/', 'build/', 'node_modules/', '*.cjs'],
  rules: {
    // Matches the root config's posture: `any` is pervasive in this codebase and failing on it would
    // hold new files to a stricter bar than anything already merged.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // TS resolves types itself, and no-undef can't see them — it reports generics and DOM lib types
    // (`T`, `FormDataEntryValue`) as undefined globals. Disabling it here is typescript-eslint's own
    // documented guidance for TS projects.
    'no-undef': 'off',
    // Default `destructuring: 'any'` flags every unreassigned binding in a `let {...} = obj` even when
    // a sibling IS reassigned — unfixable without splitting the statement (see getEdgeUrl in
    // lib/media/edge-url.ts). 'all' only reports when nothing in the pattern is reassigned.
    'prefer-const': ['error', { destructuring: 'all' }],
    // An empty arrow is the idiomatic "swallow this rejection" handler (e.g. play().catch(() => {})
    // where blocked autoplay is expected). Named empty functions are still reported. The
    // @typescript-eslint variant is the one in force — its recommended config disables the base rule.
    '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
    // Re-reports Svelte compiler diagnostics, which `pnpm check` (svelte-check) and the build already
    // own and report better. Its custom_element_props_identifier warning also cannot apply here — it
    // only matters when compiling as a custom element, which this app never does.
    'svelte/valid-compile': 'off',
  },
};
