// `root: true` so this package does not cascade up to the repo-root config. That
// config is `eslint-config-next` and its typed rules crash outright here
// (`consistent-type-imports` threw a TypeError on src/handlers/base.ts), which
// exited 2 without linting a single file.
module.exports = {
  root: true,
  // Without these the only error-level rule here is `no-unused-vars`, and CI's blocking
  // "ESLint (added files)" gate would pass event-engine files while checking them for
  // essentially nothing — a far weaker bar than the src/ and packages/ files beside them.
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  env: {
    node: true,
    es6: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],
};
