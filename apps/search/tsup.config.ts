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
});
