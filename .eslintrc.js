// The custom `no-io-in-transaction` rule lives in ./eslint-local-rules.js and
// is loaded via `eslint-plugin-local-rules`. It activates automatically once
// that dev dependency is installed (`pnpm add -D eslint-plugin-local-rules`);
// until then it is skipped so `next lint` keeps working without the dep (and
// CI's `pnpm install --frozen-lockfile` is unaffected).
const hasLocalRules = (() => {
  try {
    require.resolve('eslint-plugin-local-rules');
    return true;
  } catch {
    return false;
  }
})();

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier', ...(hasLocalRules ? ['local-rules'] : [])],
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended', // lightweight rules (no type info)
    'plugin:tailwindcss/recommended',
    // "plugin:import/typescript",
    'prettier',
  ],
  // settings: {
  //   "import/resolver": {
  //     // You will also need to install and configure the TypeScript resolver
  //     // See also https://github.com/import-js/eslint-import-resolver-typescript#configuration
  //     "typescript": true,
  //     "node": true,
  //   },
  // },
  rules: {
    // Flags awaited external I/O inside a Prisma interactive $transaction
    // callback (blows the txn timeout budget). No-op until
    // eslint-plugin-local-rules is installed (see hasLocalRules above).
    ...(hasLocalRules ? { 'local-rules/no-io-in-transaction': 'error' } : {}),

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