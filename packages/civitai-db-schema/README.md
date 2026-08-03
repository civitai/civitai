# @civitai/db-schema

The **schema contract** package: the generated Prisma client + types, and the prisma-kysely-generated
`DB` type. Every other package and app types against this rather than importing `@prisma/client`
directly, so the schema has a single source of truth.

## Add to an app

```jsonc
// package.json
"@civitai/db-schema": "workspace:*"
```

Transpile alongside its consumers (`@civitai/db`): Next `transpilePackages`, Vite `ssr.noExternal`.

Usually you don't add this directly — it comes in as a peer of `@civitai/db`. Add it explicitly when
you import the `DB` type or enums yourself.

## Exports

| Import | Gives you |
|---|---|
| `@civitai/db-schema` | `Prisma`, `PrismaClient`, and all model types (re-exported from `@prisma/client`) |
| `@civitai/db-schema/kysely` | `DB` — the full Kysely schema type (pure types, no runtime) |
| `@civitai/db-schema/enums` | Prisma enums |
| `@civitai/db-schema/models` | model types |

## Use

```ts
import type { DB } from '@civitai/db-schema/kysely'; // for createKyselyClients<DB>()
import { Prisma, PrismaClient } from '@civitai/db-schema'; // Prisma path
```

## Drift detector

`src/schema-drift/` compares the Prisma schema against a live database's `pg_catalog` and
reports constraints that are declared but not enforced (and enforced but not declared):
foreign-key presence, referential actions, nullability and uniqueness. Read-only.

```bash
pnpm --filter @civitai/db-schema drift        # needs DATABASE_URL
```

See `src/schema-drift/README.md` for what it checks and, just as importantly, what it does
not.

## Env

None for the exports above. The drift detector reads `DATABASE_URL`.

## Gotchas

- The Prisma entry needs a generated client (`pnpm run db:generate`). The `/kysely` and `/enums`
  subpaths are pure types/values and need no generation step at type-check time.
- No env, no DB connection — this is types/contracts only. Connections live in `@civitai/db`.
