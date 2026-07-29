import { defineConfig } from 'tsup';

// esbuild-backed bundle for the Node runtime. We BUNDLE the workspace @civitai/* packages (which ship
// raw .ts source) into a single ESM entry so the runtime image needs no TS toolchain. Everything in
// node_modules (fastify, prom-client, the aws-sdk) is external by tsup default and resolves from
// node_modules at runtime. Mirrors apps/orchestrator-gateway/tsup.config.ts (this app has no Prisma).
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
