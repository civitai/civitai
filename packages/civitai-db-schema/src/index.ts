// Bare `@civitai/db-schema` exposes the generated Prisma client + types.
// The generated enum objects and model interfaces are intentionally NOT merged
// here (their names overlap); import them via subpaths instead:
//   import { ... } from '@civitai/db-schema/enums';
//   import type { ... } from '@civitai/db-schema/models';
//
// `@prisma/client` is intentionally NOT a declared dependency of this package: declaring
// it makes `prisma generate` try to auto-`pnpm add @prisma/client` at the workspace root,
// which fails. It resolves via root hoisting today; the proper fix is a custom generator
// output (output = "../generated/client") so this barrel re-exports from ./generated and
// the lint exception below can be removed.
//
// NB: we do NOT `export *` from the CJS `@prisma/client` — Turbopack can't statically enumerate a
// CommonJS module's exports through a runtime `export *`, so it warns on every import. The bare index is
// only consumed for the runtime `Prisma` + `PrismaClient` (everything else is types), so re-export those
// explicitly and all types via `export type *` (zero runtime code) — same surface, no warning.
//
// The runtime values are pulled via a DEFAULT import + destructure, NOT `export { Prisma, PrismaClient }
// from '@prisma/client'`. `@prisma/client` resolves to a CommonJS file (its package `exports` map points
// the `import` condition at `default.js`, a CJS re-export module). A named ESM re-export from it fails at
// runtime under a strict-ESM bundle (esbuild `format: esm` in apps/*): Node's cjs-module-lexer can't
// statically enumerate the names, so `import { Prisma } from '@prisma/client'` throws "Named export
// 'Prisma' not found" and the process crashes on boot. Default-import (the module.exports object) then
// destructure works in BOTH webpack/CJS (monolith) and esbuild/ESM (the spun-out apps). Types are
// unaffected — `export type *` still re-exports the full type surface (incl. the `Prisma` namespace).
// eslint-disable-next-line import/no-extraneous-dependencies
import prismaClientPkg from '@prisma/client';
// Runtime values via a DEFAULT import + destructure — NOT `export { Prisma, PrismaClient } from
// '@prisma/client'`. @prisma/client's `import` condition resolves to a CJS file whose exports Node's
// cjs-module-lexer can't statically enumerate, so a named ESM re-export throws "Named export 'Prisma'
// not found" at boot under a strict-ESM bundle (esbuild `format: esm` in apps/*) — it crashed
// apps/notifications on first cluster boot. The default import is the whole module.exports object (its
// Prisma + PrismaClient runtime values are present); cast to the module namespace type — which carries
// the named-export types — so the destructure keeps its full types. Works in both webpack/CJS (monolith)
// and esbuild/ESM (spun-out apps).
const { Prisma, PrismaClient } = prismaClientPkg as unknown as typeof import('@prisma/client');
export { Prisma, PrismaClient };
// eslint-disable-next-line import/no-extraneous-dependencies
export type * from '@prisma/client';
