import { defineConfig } from 'vitest/config';

export default defineConfig({
  // svelte/reactivity's default export is its server build, where SvelteSet is a plain Set. Node tests
  // resolve through Vite's SSR resolver, which ignores a top-level `resolve.conditions`.
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
