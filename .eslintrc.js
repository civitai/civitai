// The custom `no-io-in-transaction` rule lives in ./eslint-local-rules.js and
// is loaded via the `eslint-plugin-local-rules` devDependency.
//
// Keep `eslint-config-next` on 15.x until we migrate to ESLint 9 + flat config.
// eslint-config-next 16 is flat-config-only (peer `eslint >=9`); extending it
// from eslintrc makes @eslint/eslintrc reject it and then crash formatting the
// error ("Converting circular structure to JSON"), so lint silently never runs.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier', 'local-rules'],
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

    // aligns closing brackets for tags
    'react/jsx-closing-bracket-location': ['error', 'line-aligned'],

    // 'import/no-cycle': ['error'],

    // prettier overrides
    'prettier/prettier': [
      'error',
      {
        printWidth: 100,
        endOfLine: 'auto',
        singleQuote: true,
        trailingComma: 'es5',
      },
    ],

    // rule tweaks
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }],
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': ['error'],
    '@typescript-eslint/restrict-template-expressions': [
      'warn',
      { allowBoolean: true },
    ],

    'tailwindcss/no-custom-classname': [
      'off',
      {
        whitelist: ['mantine-focus-auto'],
      },
    ],
  },

  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parserOptions: {
        project: './tsconfig.json',
      },
      // extends: ['plugin:@typescript-eslint/recommended-requiring-type-checking'],
      rules: {
        // put only the rules that *need* type info here
        // example:
        // '@typescript-eslint/no-floating-promises': 'error',
        // '@typescript-eslint/no-misused-promises': 'error',
      },
    },
    {
      // tsconfig.json excludes src/**/__tests__/**, so the type-aware parser above throws a fatal
      // "TSConfig does not include this file" error on every test file. A fatal parse error means
      // NO rule runs — including prettier/prettier, which is what the editor's fix-on-save relies
      // on to format (editor.formatOnSave is off). Result: test files silently never get formatted
      // and only fail in CI. Nothing here needs type info, so drop the project reference.
      files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
      parserOptions: { project: null },
      rules: {
        // The only type-aware rule in the shared set; it errors at load time without a project.
        '@typescript-eslint/restrict-template-expressions': 'off',
      },
    },
  ],
};