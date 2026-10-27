import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      '$env/dynamic/private': fileURLToPath(new URL('./src/test/env.mock.ts', import.meta.url)),
    },
  },
  test: {
    name: 'app:knights',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
