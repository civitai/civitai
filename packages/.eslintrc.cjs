/**
 * ESLint config for the @civitai/* workspace packages.
 *
 * `root: true` so the packages do NOT inherit the main app's React/Next/Tailwind/airbnb
 * config (they're plain TS infra, not app code). It enforces two boundary guarantees:
 *
 *   1. import/no-extraneous-dependencies — every runtime import must be a declared
 *      `dependency` in that same package's package.json. This keeps each package
 *      installable on its own by any consuming app AND makes Turborepo's cache
 *      invalidation trustworthy: turbo builds its task graph from declared deps, so an
 *      import that only resolves via root hoisting (a phantom dep) would silently skip
 *      cache busting. devDeps are allowed only in test files.
 *
 *   2. no-restricted-imports (~/...) — base packages never reach into app code; they
 *      receive app config/behavior through their createX() factory args instead.
 *
 * Run with `pnpm lint:packages`.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  // @typescript-eslint is registered (not enabled) only so inline eslint-disable comments
  // carried over from the app source resolve to a known rule. prisma/ holds scripts +
  // generated client, not package runtime source, so it's out of scope.
  plugins: ['import', '@typescript-eslint'],
  ignorePatterns: ['**/prisma/**'],
  rules: {
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: ['**/*.test.ts', '**/*.spec.ts'],
        optionalDependencies: false,
        peerDependencies: true,
      },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['~/*', '~/**'],
            message:
              'Base packages must not import app code (~/...). Pass app config/behavior in through the createX() factory instead.',
          },
        ],
      },
    ],
  },
};
