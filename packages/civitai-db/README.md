# @civitai/db

PostgreSQL access for Civitai apps: a Prisma read/write client factory **and** a standalone Kysely
client builder. Connection/pool tuning and the type-parser config live here so consumer apps don't
re-derive them.

## Add to an app

```jsonc
// package.json
"@civitai/db": "workspace:*",
"@civitai/db-schema": "workspace:*"   // peer: the generated schema/types
```

The package ships **raw TS** (`main: ./src/index.ts`), so the consumer must transpile it:

- **Next.js** — `next.config.ts`: `transpilePackages: ['@civitai/db', '@civitai/db-schema']`
- **Vite / SvelteKit** — `vite.config.ts`: `ssr.noExternal: ['@civitai/db', '@civitai/db-schema']`

`pg` and `kysely` come in transitively — **do not add them to the app** unless the app imports them
directly (e.g. `import { sql } from 'kysely'`).

## Two entry points

| Import | Returns | Env | Use when |
|---|---|---|---|
| `@civitai/db` (`createPrismaClients`) | `{ dbRead, dbWrite }` Prisma clients | **Requires** the full DB env set (below) | App uses Prisma |
| `@civitai/db/kysely` (`createKyselyClients<DB>`) | `{ dbRead, dbWrite, pool }` or `{ db, pool }` Kysely clients — `pool` is the primary pg pool | **None** — connection config is explicit | App uses Kysely (lighter; no Prisma engine) |

The `/kysely` subpath imports only `kysely` + `pg` (never Prisma), so a Vite/SSR app can use it without
pulling the Prisma engine.

## Env (Prisma entry only)

`loadDbEnv()` (called by `createPrismaClients`) **requires** all of: `DATABASE_URL`,
`DATABASE_REPLICA_URL`, `NOTIFICATION_DB_URL`, `NOTIFICATION_DB_REPLICA_URL`. Optional tuning:
`DATABASE_POOL_MAX` (20), `DATABASE_CONNECTION_TIMEOUT` (0), `DATABASE_POOL_IDLE_TIMEOUT` (30000),
`DATABASE_SSL` (true), and others — see [src/env.ts](src/env.ts).

`createKyselyClients` reads **no env** — you pass connection strings/pools yourself.

## Use — Kysely (read/write split, the spoke-app pattern)

```ts
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

export const { dbRead, dbWrite } = createKyselyClients<DB>({
  connectionString: process.env.DATABASE_URL,
  replicaConnectionString: process.env.DATABASE_REPLICA_URL,
  sslNoVerify: true, // cnpg pooler self-signed cert; see gotcha
});
```

Other shapes: `singleClient: true` → `{ db, pool }` (no replica / read-your-writes); or pass pre-built
`pool` / `readPool` (e.g. the main app's `getClient()` pools) for full control.

The returned `pool` is the **primary** pg pool backing `dbWrite`, handed back for startup work that
needs a pool rather than a Kysely instance — `registerEnumArrayTypeParsers` being the one that exists.
Kysely does not expose its dialect's pool.

## Gotchas

- **cnpg SSL**: node-postgres maps a URL's `sslmode=require` to full chain verification (unlike libpq)
  and rejects the pooler's self-signed cert. Pass `sslNoVerify: true` (rewrites the connection string to
  `sslmode=no-verify` — SSL on, verification off). Pre-built pools are passed through untouched.
- **NUMERIC/INT8 → number**: `createKyselyClients` registers pg type parsers so these come back as JS
  numbers, not strings. Registration is lazy (per-factory-call), so merely importing `@civitai/db`
  elsewhere (the Prisma path) never flips global pg parsing.
- **`pg` is transitive**: declare it in the app only if you `import 'pg'` directly.
- **Dropped connections**: a pg connection that drops (a failover drops all of them at once) emits an
  `'error'` event, and with no listener that crashes the process. Every pool `createPool`,
  `createClients` and `createKyselyClients` builds is passed through `guardPool` (`src/pool-guard.ts`),
  which logs instead: on the pool for idle clients, and on each client for one that is checked out
  (pg-pool removes its own client listener during checkout, so a pool-level listener alone misses
  that case). Pre-built pools you pass in are not guarded here — `createPool` pools already are. ESLint
  bans `new Pool` / `new pg.Pool` outside this package (`eslint-no-direct-pg-pool.cjs` at the repo root).

Reference implementation: [apps/moderator/src/lib/server/db.ts](../../apps/moderator/src/lib/server/db.ts).
