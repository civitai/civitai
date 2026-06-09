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
// eslint-disable-next-line import/no-extraneous-dependencies
export * from '@prisma/client';
