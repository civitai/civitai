import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Server-unit tests for the hub. We alias the SvelteKit virtual modules ($env / $app) to plain stubs so
// the server code under test resolves without the full SvelteKit/Vite pipeline. The parity-critical logic
// (session-shape) is pure and needs none of this; the aliases are for the auth helper + endpoint handlers.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      '$env/dynamic/private': fileURLToPath(new URL('./src/test/env.mock.ts', import.meta.url)),
      '$app/environment': fileURLToPath(new URL('./src/test/app-environment.mock.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
