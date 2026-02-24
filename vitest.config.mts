import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'tests/**/*'], // Exclude Playwright tests
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/server/services/**', 'src/server/jobs/**'],
    },
    setupFiles: ['src/__tests__/setup.ts'],
    testTimeout: 10000,
    deps: {
      inline: [/@civitai\/client/],
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
});
