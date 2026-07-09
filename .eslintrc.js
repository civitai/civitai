// The custom `no-io-in-transaction` rule lives in ./eslint-local-rules.js and
// is loaded via the `eslint-plugin-local-rules` devDependency.
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
  ],
};