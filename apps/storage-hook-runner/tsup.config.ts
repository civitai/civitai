import { defineConfig } from 'tsup';

// Two ESM entries for the Node runtime: the HTTP server and the worker_threads entry it spawns
// (src/pool.ts resolves `./worker.js` next to the bundled server). node_modules stays external
// and resolves from the pruned production node_modules at runtime, which is where the QuickJS
// `.wasm` file is read from.
export default defineConfig({
  entry: { server: 'src/server.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
});
