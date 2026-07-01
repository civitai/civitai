import { defineConfig } from 'tsup';

// esbuild-backed bundle for the Node runtime. We BUNDLE the workspace @civitai/* packages (which
// ship raw .ts source, like the auth app relies on Vite to transpile) into a single ESM entry so the
// runtime image needs no TS toolchain. External deps (fastify, prom-client, redis, pg, jose, the
// @civitai/client SDK) stay in node_modules and are resolved at runtime — `noExternal` pulls ONLY the
// workspace source packages into the bundle. Keep `platform: node` so Node builtins resolve.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Bundle the workspace source packages (they export ./src/*.ts and are not pre-built).
  noExternal: [/^@civitai\//],
  // Native/optional deps that must stay external (loaded at runtime from node_modules).
  external: ['pg', 'redis', 'jose'],
});
