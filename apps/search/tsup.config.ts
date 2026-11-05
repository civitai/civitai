import { defineConfig } from 'tsup';

// Bundles the workspace @civitai/* packages (raw .ts) into one ESM entry; node_modules stay external.
// Mirrors apps/storage/tsup.config.ts.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: [/^@civitai\//],
  // @civitai/redis brings CommonJS deps (redis, msgpackr) into the bundle, and they require Node
  // builtins, which esbuild's ESM output cannot do without a `require`.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
