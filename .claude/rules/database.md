---
paths:
  - 'packages/civitai-db-schema/**'
  - 'packages/civitai-db-queries/**'
  - '**/migrations/**'
---

# Database

## Choosing a query client

Main-app service code gets this from `.claude/rules/server.md` (Use X for Y), which loads on `src/server/**`:

- Reads use `dbRead` / `kyselyRead`; read-after-write uses `getDbWithoutLag` / `getKyselyWithoutLag`. A plain read on `dbWrite` needs a `// primary: <reason>` comment.
- New queries use Kysely (`kyselyRead` / `kyselyWrite`) or a function in `@civitai/db-queries`; Prisma ORM is fine for simple CRUD. New raw SQL goes in `@civitai/db-queries` as a Kysely `sql` query (the package has no Prisma client); add no new `$queryRaw` / `$executeRaw` in app code. The plan: `docs/db-queries-kysely-plan.md`.
- A row type comes from the generated Kysely types: `Selectable<DB['Table']>`, or `Pick<Selectable<DB['Table']>, 'id' | 'name'>` for a subset. Never hand-write an object type that repeats a table's columns, and keep the schema's nullability (no `| null` on a `NOT NULL` column). Let a query's result type be inferred rather than restated. `DB` is `@civitai/db-schema/kysely` (an app with its own database uses its own `DB`).

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

## Event tracking goes to ClickHouse, not Postgres

Event and activity records (downloads, views, accesses, clicks: anything appended per action and read for analytics or audit) go to ClickHouse through the existing tracker (`src/server/clickhouse/tracker.ts`), not into a new Postgres table. A PR that stores event data in Postgres needs a written reason, agreed with the project owner before the PR is opened.

## Migration details

- Migration files live in `packages/civitai-db-schema/prisma/migrations/` for review/history and are never auto-run. It is the only directory Prisma reads; the root `prisma/migrations/` path predates the monorepo, no longer exists, and CI blocks re-creating it.
- A human applies each environment's SQL directly (psql, retool, etc.). The `_prisma_migrations` table is not the source of truth; don't rely on it.
- **After writing a migration, list these steps for the human applier**, per writable environment (procedure, flags and limits: "After applying a migration" in `packages/civitai-db-schema/src/schema-drift/README.md`):

  1. Dry run: the migration inside `BEGIN; … ROLLBACK;` against the target.
  2. Apply it.
  3. Scoped drift check, read-only: `DATABASE_URL=<target, read-only role> pnpm --filter @civitai/db-schema drift --migration prisma/migrations/<dir>/migration.sql`. Exit 2 means it could not vouch for the scope (unclassifiable statements, or a table missing from the schema or database); see the README for `--allow-unparsed --tables`.
  4. Clean, or fix it. A remaining delta that is intended is accepted in a PR with `pnpm --filter @civitai/db-schema drift:baseline --reason "<specific why>" --ref "#<PR>"`.

  The drift check does not cover indexes, defaults, types, check constraints or views, so verify those directly.

- The Comment v3 tables (`CommentV3`, `CommentTopic` and their reaction, report and mute tables) are declared in `schema.full.prisma` for type generation only. prisma-kysely drops `Unsupported` columns, so read them through `kyselyV3Read` (`src/server/db/kyselyDb.ts`), which adds `path` and makes `rootId`/`depth` select-only; `kyselyV3Write` has the same typing for backfill and tooling. Write comments through `commentv3/write.service.ts`, raw SQL that runs inside the caller's Prisma transaction. Their partial and GiST indexes live only in the migration.

## Adding an enum value: deploy first, then migrate, then write

`ALTER TYPE ... ADD VALUE` is harmless alone; writing rows that use the new label is not. Treat an additive enum as expand/contract:

1. **Deploy** the regenerated client (knows the value, writes none), so every reader can decode it.
2. **Apply** `ALTER TYPE ... ADD VALUE` (value exists, still unused).
3. **Backfill / enable writes** (first rows appear, safely).

Applying the migration before the deploy is safe only while nothing writes the value. A backfill writes the moment you run it regardless of what is deployed, and pods on the previous build then break on read until the deploy lands.

Why: Prisma deserializes enum columns strictly, so an unknown label throws on read, not on the write. Every page selecting the column 500s, and for a Prisma-mapped view that is every consumer of the view. A migration plus backfill that ran ahead of the deploy 500ed every model page when adding `ModelHashType.SHA256_12` (2026-08-19).
