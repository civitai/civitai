// ESM ↔ CJS interop shim for @prisma/client (wired via the tsup alias in tsup.config.ts).
//
// The monorepo's @civitai/db-schema barrel does `export { Prisma, PrismaClient } from '@prisma/client'`,
// and @civitai/db calls `Prisma.sql` / `new PrismaClient()` at runtime. @prisma/client resolves to a
// CommonJS module whose exports Node's cjs-module-lexer can't statically enumerate, so a NAMED ESM
// import (`import { Prisma } from '@prisma/client'`) throws "Named export 'Prisma' not found" at
// instantiation once bundled into this app's strict-ESM output (esbuild `format: esm`).
//
// This shim is aliased in place of @prisma/client in the app bundle only (the monolith is untouched —
// it builds with webpack/CJS where the named re-export is fine). It loads the REAL client via a
// createRequire (CJS require → module.exports, always safe) and re-exports the named members as proper
// ESM. The specifier is assembled at runtime so esbuild can't statically resolve it back to this shim
// (which would loop) — it stays a real runtime require of the installed @prisma/client.
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const prismaClientPkg = nodeRequire(['@prisma', 'client'].join('/'));

export const Prisma = prismaClientPkg.Prisma;
export const PrismaClient = prismaClientPkg.PrismaClient;
