import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// esbuild-backed bundle for the Node runtime. We BUNDLE the workspace @civitai/* packages (which ship
// raw .ts source) into a single ESM entry so the runtime image needs no TS toolchain. Everything in
// node_modules (fastify, prom-client, dayjs, lodash-es, …) is external by tsup default; the list below
// force-externalizes the transitive native/CJS deps that reach us THROUGH the bundled @civitai/*
// source (pg + pg-format via @civitai/db, redis via @civitai/redis, the Prisma runtime + axiom SDK) —
// they must resolve from node_modules at runtime, not get inlined. Mirrors
// apps/orchestrator-gateway/tsup.config.ts.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: [/^@civitai\//],
  external: ['pg', 'pg-format', 'redis', '@prisma/client', '.prisma/client', '@axiomhq/axiom-node'],
  esbuildOptions(options) {
    // Redirect @prisma/client to an ESM interop shim (see prisma-client.shim.mjs). The @civitai/db-schema
    // barrel re-exports { Prisma, PrismaClient } from the CJS @prisma/client; a named ESM import of it
    // crashes at boot in this strict-ESM bundle. The shim default-requires the real client and re-exports
    // the values as ESM. App-scoped — the monolith (webpack) still imports @prisma/client directly.
    options.alias = {
      ...(options.alias ?? {}),
      '@prisma/client': fileURLToPath(new URL('./prisma-client.shim.mjs', import.meta.url)),
    };
  },
});
