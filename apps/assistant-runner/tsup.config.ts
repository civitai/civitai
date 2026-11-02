import { defineConfig } from 'tsup';

// One ESM bundle for the Node runtime. Everything in node_modules stays external (tsup's default)
// and resolves from the pruned production node_modules at runtime.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  // The workspace packages ship TypeScript source, so they are bundled rather than left external.
  noExternal: ['@civitai/app-assistant', '@civitai/shared'],
  sourcemap: true,
  clean: true,
});
