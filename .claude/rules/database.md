---
paths:
  - "packages/civitai-db-schema/**"
  - "**/migrations/**"
---

# Database

## Commands and schema files

```bash
pnpm run db:migrate:empty    # Create an empty migration file
pnpm run db:generate         # Regenerate the slim schema + Prisma client
pnpm run db:check-generated  # Fail if the committed generated client is stale
pnpm run db:moderator:pull   # Re-introspect the moderator DB into apps/moderator/prisma/schema.prisma
```

- **How generation works:** `pnpm run db:generate` runs `scripts/generate-slim-schema.js`, which strips `@no-type` models/enums into `packages/civitai-db-schema/prisma/schema.prisma` (what `package.json`'s `prisma.schema` points at), then runs `prisma generate`.
- **Never edit the main app's generated `schema.prisma` files.** That one and the leftover `prisma/schema.prisma` at the repo root are gitignored build artifacts, overwritten on the next generate.
- **`apps/moderator/prisma/schema.prisma` is separate and tracked.** It is introspected, never authored: run `pnpm run db:moderator:pull` then `pnpm run db:moderator:generate` (see `apps/moderator/CLAUDE.md`). `db:generate` does not produce it.
- **Run `pnpm run db:check-generated` after touching `schema.full.prisma`.** It regenerates and diffs `packages/civitai-db-schema/src`, so a forgotten regen fails there.

## Migration details

- Migration files live in `packages/civitai-db-schema/prisma/migrations/` for review/history and are never auto-run. It is the only directory Prisma reads; the root `prisma/migrations/` path predates the monorepo, no longer exists, and CI blocks re-creating it.
- A human applies each environment's SQL directly (psql, retool, etc.). The `_prisma_migrations` table is not the source of truth; don't rely on it.

## Adding an enum value: deploy first, then migrate, then write

`ALTER TYPE ... ADD VALUE` is harmless alone; writing rows that use the new label is not. Treat an additive enum as expand/contract:

1. **Deploy** the regenerated client (knows the value, writes none), so every reader can decode it.
2. **Apply** `ALTER TYPE ... ADD VALUE` (value exists, still unused).
3. **Backfill / enable writes** (first rows appear, safely).

Applying the migration before the deploy is safe only while nothing writes the value. A backfill writes the moment you run it regardless of what is deployed, and pods on the previous build then break on read until the deploy lands.

Why: Prisma deserializes enum columns strictly, so an unknown label throws on read, not on the write. Every page selecting the column 500s, and for a Prisma-mapped view that is every consumer of the view. A migration plus backfill that ran ahead of the deploy 500ed every model page when adding `ModelHashType.SHA256_12` (2026-08-19).
