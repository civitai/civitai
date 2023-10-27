module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
  },
  plugins: [
    '@typescript-eslint',
    'prettier',
    // 'import',
  ],
  extends: [
    'next/core-web-vitals',
    // 'plugin:@next/next/recommended',
    'plugin:@typescript-eslint/recommended',
    // 'plugin:import/recommended',
    // 'plugin:import/typescript',
    'prettier',
  ],
  rules: {
    // aligns closing brackets for tags
    'react/jsx-closing-bracket-location': ['error', 'line-aligned'],
    // turn on errors for missing imports
    // 'import/no-unresolved': 'error',
    // prettier overrides
    'prettier/prettier': ['error', {
      printWidth: 100,
      endOfLine: 'auto',
      singleQuote: true,
      trailingComma: 'es5',
    }],
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'off',
    // allows ignoring ts checks
    '@typescript-eslint/ban-ts-comment': 'off',
    // allows destructuring to ignore fields
    '@typescript-eslint/no-unused-vars': ['warn', { 'ignoreRestSiblings': true }],
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off'
  },
  // settings: {
  //   'import/parsers': {
  //     '@typescript-eslint/parser': ['.ts', '.tsx']
  //   },
  //   'import/resolver': {
  //     typescript: {
  //       // always try to resolve types under `<root>@types` directory even it doesn't contain any source code, like `@types/unist`
  //       alwaysTryTypes: true,
  //     }
  //   }
  // }
}
