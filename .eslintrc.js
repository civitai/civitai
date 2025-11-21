module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier'],
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