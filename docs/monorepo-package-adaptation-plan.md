# Monorepo — Base Package Adaptation Plan

**Status:** Planning only. The base-package file *moves* are staged but **not yet committed**;
none of the content rewrites below have been applied. This document is the concrete
implementation spec for turning the five staged base packages into true,
infrastructure-only packages that import **external npm dependencies only**.

Read first: [`monorepo-bootstrap-handoff.md`](./monorepo-bootstrap-handoff.md) and
[`monorepo-conversion-plan.md`](./monorepo-conversion-plan.md). This doc supersedes the
"Phase 1–5" sketch in those with worked, code-level detail.

---

## 1. The rule we are enforcing

A base package (`@civitai/db`, `@civitai/redis`, `@civitai/clickhouse`, `@civitai/axiom`,
`@civitai/telemetry`) may import **external npm packages only**. It must not import:

- another base package (no `db → axiom`, no `telemetry → db`),
- an app service (`~/server/flipt`, `~/server/auth`, …),
- app config (`~/env/server`, `~/env/other`),
- app utilities (`~/utils/*`, `~/server/utils/*`),
- app domain types/schemas (`~/server/schema/*`, `~/server/common/*`, `~/shared/*`).

Anything that needs one of those is a **consumer** of infrastructure, not infrastructure,
and either (a) gets its dependency **injected**, or (b) **moves back** to the main app.

**One exception — the contract layer.** `@civitai/db-schema` (Prisma schema + generated
types, §4.0) is a **leaf artifact** with no runtime. Infra packages may depend **downward** on
it (e.g. `@civitai/db` imports the generated Prisma client from `@civitai/db-schema`), exactly
as they depend on any npm package. The no-sibling rule still holds: it only forbids one infra
package importing *another infra package's runtime*. A pure types/schema package is a lower
layer, not a sibling.

## 2. The pattern: factory + injected deps + app-side shim

Every package stops exporting eager module-level singletons and instead exports a
**factory**: `createXClients(config)`. The `config` carries two kinds of things:

1. **Plain values** the package reads from `env` today (URLs, timeouts, booleans).
2. **Injected functions** for concerns the package may not own:
   - a `log` function (replaces `~/utils/logging`'s `createLogger`),
   - cross-cutting callbacks (`onSlowQuery → axiom`, `isEnhancedFailoverEnabled → flipt`, …).

Each **app** keeps a thin **shim** at the original import path
(`src/server/db/client.ts`, `src/server/redis/client.ts`, …). The shim:

- calls the factory with that app's real `env`, real logger, real flipt/axiom wiring,
- **owns the dev/HMR `global.*` singleton caching** (per decision: globals live where the
  factory is called, never inside the package),
- **re-exports the same names** (`dbRead`, `dbWrite`, `redis`, `sysRedis`, …) so every
  existing call site keeps working unchanged.

Because the shims are app code, they may freely compose multiple base packages (e.g. the
db shim may import `logToAxiom` from the axiom shim). The **package-level** "no sibling
imports" rule is what stays inviolate.

### 2.1 The injected logger

Each factory takes an **optional** `log` parameter, defaulting to a no-op. The package never
logs on its own; when an app wants visibility it injects a logger (the main app injects one
into every factory). To avoid a shared logger package (which would itself be a cross-package
import), each package declares its own **structural** logger type; the app's single logger
duck-types into all of them:

```ts
// declared independently inside each package — structural, so one app logger satisfies all
export type LogFn = (message: string, ...args: unknown[]) => void;
const noop: LogFn = () => {};
// in the factory:  const log = config.log ?? noop;
```

The main app builds one `LogFn` per domain from the existing `createLogger(name, color)` and
passes it in. Structured telemetry that currently goes to Axiom (db slow queries, clickhouse
insert errors) is a **separate** injected callback, not a log line — see each package below.

### 2.2 Environment variables — packages never import an env module

A base package **must not import any `env`** — not the app's `~/env/server`, not a shared one.
Factories accept **plain typed values** (`isProd`, URLs, timeouts). The app reads its own env
and passes those values in. This keeps packages reuse-agnostic: a package never assumes *how*
its config is sourced.

> The current monolithic `~/env/server` exists only because the project started from a starter
> that validated all env vars against one schema. We are **not** carrying that coupling into the
> packages. If we later want per-domain env→schema validation back, it lives as a **scoped env
> file inside each package** (the package ships its own zod/`@t3-oss/env` schema + a
> `configFromEnv(process.env)` helper). That stays **opt-in** — the core factory still takes
> plain values, so an app can validate however it likes (or not at all).

**No `isBuild` in factories.** The old `if (!env.IS_BUILD)` guard (skip opening connections
during `next build`) is an *app/runtime* concern — `isBuild` ≠ `isProd` (a production build
has `isProd === true` but must still not connect). Since the **shim** owns instantiation, the
shim keeps the build guard; the package factory only takes `isProd` where behavior genuinely
differs (e.g. slow-query → console vs Axiom). See §4.2.

---

## 3. Boundary-import inventory (complete)

Every `~/…` import found in the five packages, and its resolution:

| Import | Package(s) | Resolution |
|--------|-----------|-----------|
| `env` (`~/env/server`) | all | **never imported** — factory takes plain config values; app sources them (§2.2) |
| `isProd` (`~/env/other`) | db, redis, clickhouse, axiom | **config boolean** `isProd` (the only env-flag; no `isBuild`) |
| `logToAxiom` (`~/server/logging/client`) | db, clickhouse | **inject** `onSlowQuery` / `onError`; axiom stays a sibling, never imported |
| `isFlipt` / `FLIPT_FEATURE_FLAGS` (`~/server/flipt/client`) | redis | **inject** `isEnhancedFailoverEnabled` |
| `createLogger` (`~/utils/logging`) | db, redis, clickhouse | **inject** optional `log?: LogFn` (default no-op) |
| `slugit` (`~/utils/string-helpers`) | redis | **inline** (pure 3-line helper) |
| `limitConcurrency` (`~/server/utils/concurrency-helpers`) | db (`db-helpers.ts`) | **vendor or inline** (see §4.6) |
| `sleep` (`~/utils/errorHandling`) | clickhouse | moves out with the Tracker (or inline) |
| `getServerAuthSession` (`~/server/auth/...`) | clickhouse | **moves back** with the Tracker |
| domain type imports (`~/server/common/enums`, `~/server/jobs/...`, `~/server/schema/...`, `~/shared/...`) | clickhouse | **moves back** with the Tracker |
| `pgDb`/`notifDb`/`datapacketDb` reads (`~/server/db/...`) | telemetry | pool-gauge block **moves back** to the app |
| `dbWrite` (`~/server/db/client`) | db (`db-helpers.ts`) | in-package cycle — **pass `dbWrite` as a param** (§4.5) |

---

## 4. The contract layer + `@civitai/db` (heaviest)

Today's staged `@civitai/db` actually bundles **two separable concerns** — the schema/types
*contract* and the Prisma-client *runtime*. The [`civitai-advertising`](file:///C:/Work/civitai-advertising)
project drives **Kysely** off a Prisma-generated schema (two generators on one
`schema.prisma`: `prisma-client` → `./generated`, `prisma-kysely` → Kysely `DB` types; runtime
is `new Kysely<DB>()` over a raw `pg.Pool`, never the Prisma client). To let a future app pick
Kysely without dragging in the Prisma-client runtime, the contract is split into its own
package.

### 4.0 `@civitai/db-schema` — source-of-truth contract (LEAF package)

Pure artifact: schema + migrations + **generated types**. No runtime, no `env`, no `@civitai/*`
dependency. Both `@civitai/db` (Prisma runtime) and any future Kysely app/package depend
**downward** on it — this is allowed (it's a lower layer, like depending on `@prisma/client`);
it does **not** violate the no-sibling-imports rule, which only forbids one infra package
importing another infra package.

**Layout** (`packages/civitai-db-schema/`):

| Path | Role |
|------|------|
| `prisma/schema.full.prisma` | source of truth — datasource + **both** generators |
| `prisma/migrations/`, `prisma/views/`, programmability | migration history (applied **manually**, per CLAUDE.md) |
| `generated/client/` | `prisma-client` generator output |
| `src/kysely/types.ts`, `src/kysely/enums.ts` | `prisma-kysely` generator output (**baked in now**) |
| `src/enums.ts`, `src/models.ts` | Prisma-generated enums/models (moved from `@civitai/db`) |

**Both generators off one schema:**

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../generated/client"
  previewFeatures = ["views"]
}
generator kysely {
  provider     = "prisma-kysely"
  output       = "../src/kysely"
  fileName     = "types.ts"
  enumFileName = "enums.ts"
}
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
```

Owns the `db:generate` / `db:migrate*` scripts — their paths move from `prisma/...` to
`packages/civitai-db-schema/prisma/...`. **Migrations stay manual** — this move doesn't change
the apply path; `scripts/prisma-migrate-with-views-workaround.mjs` references update to the new
path. Exports: generated Prisma client + types, `enums`, `models`, and the Kysely `DB` type via
subpath `@civitai/db-schema/kysely`.

> Adding `prisma-kysely` + creating this package is the **only content edit** authorized here
> (schema gets a second generator block + `prisma-kysely` dev-dep); the actual *file relocation*
> of `prisma/`, `enums.ts`, `models.ts` into `packages/civitai-db-schema/` is a pure move.

### 4.1 `@civitai/db` — Prisma-client runtime (depends on `@civitai/db-schema`)

**Package** (`packages/civitai-db/src/`) — reusable Postgres machinery, no `env`, no globals;
imports the generated client + types from `@civitai/db-schema`:

| File | Role |
|------|------|
| `client.ts` | `createPrismaClients(config)` — Prisma read/write factory |
| `db-helpers.ts` | `getClient(config)` pg-`Pool` factory + pure SQL utils + param-bound stateful helpers |

(`enums.ts`, `models.ts`, `prisma/` have moved **down** to `@civitai/db-schema`.)

**App shims** (`src/server/db/`) — instantiate with `env`, own the `global.*` caches,
re-export the existing names:

| Shim | Calls | Re-exports |
|------|-------|-----------|
| `client.ts` | `createPrismaClients` | `dbRead`, `dbWrite` |
| `pgDb.ts` | `getClient` ×3 | `pgDbWrite`, `pgDbRead`, `pgDbReadLong` |
| `notifDb.ts` | `getClient` ×2 | `notifDbWrite`, `notifDbRead` |
| `datapacketDb.ts` | `getClient` ×1 | `datapacketDbRead` |
| `db-helpers.ts` | re-export pkg utils; bind `dbWrite` into stateful helpers | `getCurrentLSN`, `checkNotUpToDate`, `dbKV`, all pure utils |

> Note: `pgDb.ts`, `notifDb.ts`, `datapacketDb.ts` currently sit **inside** the package
> (we moved them there). Under this plan their **singleton** halves move back to
> `src/server/db/` as shims; only `getClient` (their factory) stays in the package. This is
> a follow-up content commit, done **after** the pure-move commit lands.

### 4.2 Prisma factory (`client.ts`)

**Before** — eager singleton, reads `env`, imports axiom
([`client.ts:31`](../packages/civitai-db/src/client.ts#L31)):

```ts
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
...
export let dbRead: PrismaClient;
export let dbWrite: PrismaClient;
if (!env.IS_BUILD) { /* isProd ? … : global.globalDbWrite ??= … */ }
```

**After** — package side, factory only:

```ts
// packages/civitai-db/src/client.ts
// Prisma client + types come from the contract package, never @prisma/client directly:
import type { Prisma } from '@civitai/db-schema';
import { PrismaClient } from '@civitai/db-schema';

export type LogFn = (message: string, ...args: unknown[]) => void;

export type PrismaClientsConfig = {
  databaseUrl: string;
  replicaUrl: string;
  isProd: boolean;                   // the only env-flag the factory needs (no isBuild)
  logging: string[];                 // env.LOGGING
  log?: LogFn;                       // optional injected logger (defaults to no-op)
  /** structured slow-query telemetry (the old logToAxiom call). Optional. */
  onSlowQuery?: (e: { query: string; duration: number; target: 'read' | 'write' }) => void;
};

export type PrismaClients = { dbRead: PrismaClient; dbWrite: PrismaClient };

export function createPrismaClients(config: PrismaClientsConfig): PrismaClients {
  const singleClient = config.replicaUrl === config.databaseUrl;

  const logFor = (target: 'read' | 'write') =>
    (e: { query: string; params: string; duration: number }) => {
      if (e.duration < 2000) return;
      const query = substituteParams(e.query, e.params);   // existing $1-substitution logic
      if (!config.isProd) console.log(query);
      else config.onSlowQuery?.({ query, duration: e.duration, target });   // ← injected, no axiom import
    };

  const createOne = ({ readonly }: { readonly: boolean }): PrismaClient => {
    const log = buildPrismaLogDefs(config.logging);          // existing log-def logic
    const url = readonly ? config.replicaUrl : config.databaseUrl;
    const prisma = new PrismaClient({ log, datasources: { db: { url } } });
    // prisma-showparams / prisma-slow-* wiring unchanged, gated on config.logging
    return prisma;
  };

  // no isBuild here — the shim decides whether to call the factory at all during `next build`
  const dbWrite = createOne({ readonly: false });
  const dbRead = singleClient ? dbWrite : createOne({ readonly: true });
  // slow-query $on wiring uses logFor(...) + config.logging, exactly as today
  return { dbRead, dbWrite };
}
```

**After** — app shim owns env + globals + axiom wiring:

```ts
// src/server/db/client.ts  (app shim, original path preserved)
import { createPrismaClients, type PrismaClients } from '@civitai/db';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('prisma', 'green');

declare global {
  // eslint-disable-next-line no-var
  var __civitaiPrisma: PrismaClients | undefined;
}

// build guard lives in the shim (not the factory): don't open connections during `next build`
const clients = env.IS_BUILD
  ? ({ dbRead: undefined as never, dbWrite: undefined as never })
  : (global.__civitaiPrisma ??= createPrismaClients({
      databaseUrl: env.DATABASE_URL,
      replicaUrl: env.DATABASE_REPLICA_URL,
      isProd,
      logging: env.LOGGING,
      log,
      onSlowQuery: ({ query, duration, target }) => logToAxiom({ query, duration, target }, 'db-logs'),
    }));

export const dbRead = clients.dbRead;
export const dbWrite = clients.dbWrite;
```

> In production `??=` still assigns once per process; in dev it reuses the HMR global —
> identical behavior to today's `global.globalDbWrite` block, just relocated to the shim.

### 4.3 pg `Pool` factory (`getClient` in `db-helpers.ts`)

`getClient` ([`db-helpers.ts:85`](../packages/civitai-db/src/db-helpers.ts#L85)) currently reads
`env` for URLs, timeouts, pool sizes, `PODNAME`, `IS_DATAPACKET`, SSL. Convert it to take a
config object. The `types.setTypeParser(TIMESTAMP, …)` side effect (currently top-of-file in
each singleton) moves **into the pool factory** so it runs at pool creation.

```ts
// packages/civitai-db/src/db-helpers.ts (package side)
export type PgInstance =
  | 'primary' | 'primaryRead' | 'primaryReadLong'
  | 'notification' | 'notificationRead' | 'datapacketRead';

export type PgClientConfig = {
  log?: LogFn;                           // optional, default no-op
  isDatapacket: boolean;
  podName?: string;
  ssl: boolean;                          // env.DATABASE_SSL !== false
  urls: Record<PgInstance, string>;      // resolved URLs (with fallbacks) from the app
  timeouts: {
    connection: number; read?: number; write?: number; poolIdle: number;
  };
  poolMax: number; notificationPoolMax?: number;
};

export function getClient(instance: PgInstance, config: PgClientConfig): AugmentedPool {
  // identical pool construction, but every `env.X` becomes `config.X`
  // pgPoolAcquireHistogram (raw prom-client) stays — prom-client is an external dep, allowed
}
```

App shim instantiates the singletons and owns the globals (one shim file per existing path):

```ts
// src/server/db/pgDb.ts  (app shim)
import { getClient, type AugmentedPool, type PgClientConfig } from '@civitai/db';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';

const cfg: PgClientConfig = {
  log: createLogger('pgDb', 'blue'),
  isDatapacket: env.IS_DATAPACKET,
  podName: env.PODNAME,
  ssl: env.DATABASE_SSL !== false,
  urls: {
    primary: env.DATABASE_URL,
    primaryRead: env.DATABASE_REPLICA_URL ?? env.DATABASE_URL,
    primaryReadLong: env.DATABASE_REPLICA_LONG_URL ?? env.DATABASE_URL,
    notification: env.NOTIFICATION_DB_URL,
    notificationRead: env.NOTIFICATION_DB_REPLICA_URL ?? env.NOTIFICATION_DB_URL,
    datapacketRead: env.DATAPACKET_DATABASE_RO_URL ?? env.DATABASE_URL,
  },
  timeouts: {
    connection: env.DATABASE_CONNECTION_TIMEOUT,
    read: env.DATABASE_READ_TIMEOUT, write: env.DATABASE_WRITE_TIMEOUT,
    poolIdle: env.DATABASE_POOL_IDLE_TIMEOUT,
  },
  poolMax: env.DATABASE_POOL_MAX, notificationPoolMax: env.NOTIFICATION_POOL_MAX,
};

declare global {
  // eslint-disable-next-line no-var
  var globalPgWrite: AugmentedPool | undefined;
  // eslint-disable-next-line no-var
  var globalPgRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var
  var globalPgReadLong: AugmentedPool | undefined;
}

const single = (env.DATABASE_REPLICA_URL ?? env.DATABASE_URL) === env.DATABASE_URL;
export const pgDbWrite = (global.globalPgWrite ??= getClient('primary', cfg));
export const pgDbRead = (global.globalPgRead ??= single ? pgDbWrite : getClient('primaryRead', cfg));
export const pgDbReadLong = (global.globalPgReadLong ??= single ? pgDbWrite : getClient('primaryReadLong', cfg));
```

`notifDb.ts` and `datapacketDb.ts` shims follow the same shape (their own globals + instances).

### 4.4 Pure utilities — re-export untouched

These functions in `db-helpers.ts` have **no** `env`/client dependency and stay in the
package as plain exports: `queryWithTimeout`, `dataProcessor`, `batchProcessor`,
`templateHandler`, `parameterizedTemplateHandler`, `combineSqlWithParams`, `getExplainSql`,
`jsonbArrayFrom`, `formatSqlType`. The app `db-helpers.ts` shim just `export * from '@civitai/db'`
for these.

### 4.5 Breaking the in-package cycle (`db-helpers → client`)

`getCurrentLSN`, `checkNotUpToDate`, and `dbKV`
([`db-helpers.ts:343-553`](../packages/civitai-db/src/db-helpers.ts#L343-L553)) call `dbWrite`.
Today that's `import { dbWrite } from '~/server/db/client'` — an in-package cycle once both
files live in `@civitai/db`. **Fix: pass `dbWrite` in.**

```ts
// package side — stateless, takes the client
export async function getCurrentLSN(dbWrite: PrismaClient): Promise<string> { /* … */ }
export function makeDbKV(dbWrite: PrismaClient) {
  return { get: async <T>(k: string, d?: T) => { /* … */ }, set: async <T>(k: string, v: T) => { /* … */ } };
}
```

```ts
// src/server/db/db-helpers.ts (app shim) — bind the app's dbWrite once
import { dbWrite } from '~/server/db/client';
import * as pkg from '@civitai/db';
export * from '@civitai/db';                                  // pure utils + getClient
export const getCurrentLSN = () => pkg.getCurrentLSN(dbWrite);
export const checkNotUpToDate = (lsn: string) => pkg.checkNotUpToDate(dbWrite, lsn);
export const dbKV = pkg.makeDbKV(dbWrite);
```

Call sites (`import { dbKV } from '~/server/db/db-helpers'`) are unchanged.

### 4.6 `limitConcurrency`

`dataProcessor`/`batchProcessor` use `limitConcurrency` from
`~/server/utils/concurrency-helpers`. **Resolution:** verify that file is dependency-free
(pure Promise scheduling); if so, **vendor a copy** into `packages/civitai-db/src/` (or a
small `@civitai/db` internal util). If it has app deps, **inline** the single function. Do
**not** import it from the app. _(Sub-task: confirm `concurrency-helpers.ts` purity.)_

---

## 5. `@civitai/redis` (keep `client.ts` only)

Package surface: `createRedisClients(config)` returning `{ redis, sysRedis }` plus the static
`REDIS_KEYS` / `REDIS_SYS_KEYS` / `REDIS_SUB_KEYS` key definitions (these are pure constants,
exported directly).

### 5.1 Inject the Flipt-gated failover policy

**Before** ([`client.ts:333`](../packages/civitai-redis/src/client.ts#L333)):

```ts
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { slugit } from '~/utils/string-helpers';
const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER, 'redis-cluster', fliptContext);
```

**After** — package knows nothing about Flipt; the answer is injected:

```ts
// packages/civitai-redis/src/client.ts
export type RedisClientsConfig = {
  url: string; sysUrl: string; timeout: number;
  cluster: boolean; clusterNodes?: string; clusterRefreshInterval: number;
  nextAuthUrl?: string; fliptDeploymentId?: string;     // failover-context inputs (were env.*)
  log?: LogFn;                                           // optional; replaces createLogger
  /** app policy, injected. Defaults to OFF — package never names Flipt. */
  isEnhancedFailoverEnabled?: (ctx: Record<string, string>) => Promise<boolean>;
};

// inlined — was ~/utils/string-helpers
const slugit = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function createRedisClients(config: RedisClientsConfig) {
  // …existing client/cluster construction, env.X → config.X…
  // in the cluster failover block:
  const enabled = (await config.isEnhancedFailoverEnabled?.(fliptContext)) ?? false;
  if (enabled) triggerTopologyRediscovery(baseClient, reason);
  return { redis, sysRedis };
}

export const REDIS_KEYS = { /* … unchanged constant tree … */ } as const;
export const REDIS_SYS_KEYS = { /* … */ } as const;
export const REDIS_SUB_KEYS = { /* … */ } as const;
```

**App shim** wires real Flipt + owns globals:

```ts
// src/server/redis/client.ts (app shim)
import { createRedisClients, REDIS_KEYS, REDIS_SYS_KEYS, REDIS_SUB_KEYS } from '@civitai/redis';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

declare global { /* eslint-disable-next-line no-var */ var __civitaiRedis: ReturnType<typeof createRedisClients> | undefined; }

// build guard in the shim: skip client creation during `next build`
const clients = global.__civitaiRedis ??= env.IS_BUILD ? ({} as ReturnType<typeof createRedisClients>) : createRedisClients({
  url: env.REDIS_URL, sysUrl: env.REDIS_SYS_URL, timeout: env.REDIS_TIMEOUT,
  cluster: env.REDIS_CLUSTER, clusterNodes: env.REDIS_CLUSTER_NODES,
  clusterRefreshInterval: env.REDIS_CLUSTER_REFRESH_INTERVAL,
  nextAuthUrl: env.NEXTAUTH_URL, fliptDeploymentId: env.FLIPT_DEPLOYMENT_ID,
  log: createLogger('redis', 'green'),
  isEnhancedFailoverEnabled: (ctx) =>
    isFlipt(FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER, 'redis-cluster', ctx),
});

export const { redis, sysRedis } = clients;
export { REDIS_KEYS, REDIS_SYS_KEYS, REDIS_SUB_KEYS };
// plus re-export the RedisKeyTemplate* types consumers import from here
```

Everything that previously lived in `civitai-redis` (`caches.ts`, `queues.ts`,
`resource-data.redis.ts`, `entity-metric.redis.ts`, `entity-metric-populate.ts`,
`fail-open-log.ts`) is already moved back to `src/server/redis/` and imports the shim — no
change needed there.

---

## 6. `@civitai/clickhouse` (split: base client stays, Tracker moves back)

`clickhouse/client.ts` mixes two concerns:

- **Infrastructure** — `createClient` + the `$query` / `$exec` template helpers. Needs only
  `CLICKHOUSE_HOST/USERNAME/PASSWORD` and an injected error hook.
- **The Tracker** — request/session-bound event recording. Imports `getServerAuthSession`,
  `NextApiRequest`/`Response`, `Session`, `request-ip`, and app schemas/enums
  (`new-order.schema`, `entity-moderation`, `user.schema`, `browsingLevel.constants`). This
  is **main-app domain** and, per discussion, other apps won't use it the same way — at most
  they need to pass a `userId` to an insert.

### 6.1 Package = base client only

```ts
// packages/civitai-clickhouse/src/client.ts
import type { ClickHouseClient } from '@clickhouse/client';
import { createClient } from '@clickhouse/client';

export type ClickhouseConfig = {
  host: string; username: string; password: string;
  isProd: boolean;
  log?: LogFn;                       // optional, default no-op
  /** insert/query error telemetry (was logToAxiom). Injected. */
  onError?: (data: Record<string, unknown>, datastream?: string) => void;
};

export type CustomClickHouseClient = ClickHouseClient & {
  $query: <T extends object>(q: TemplateStringsArray | string, ...v: any[]) => Promise<T[]>;
  $exec: (q: TemplateStringsArray | string, ...v: any[]) => Promise<void>;
};

export function createClickhouseClient(config: ClickhouseConfig): CustomClickHouseClient {
  // existing createClient + $query/$exec wiring; env.X → config.X; logToAxiom → config.onError
}
```

### 6.2 App shim + relocated Tracker

```ts
// src/server/clickhouse/client.ts (app shim)
import { createClickhouseClient } from '@civitai/clickhouse';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { logToAxiom } from '~/server/logging/client';

declare global { /* … */ var globalClickhouse: ReturnType<typeof createClickhouseClient> | undefined; }

// build guard in the shim
export const clickhouse = global.globalClickhouse ??= env.IS_BUILD
  ? (undefined as never)
  : createClickhouseClient({
      host: env.CLICKHOUSE_HOST, username: env.CLICKHOUSE_USERNAME, password: env.CLICKHOUSE_PASSWORD,
      isProd, log: createLogger('clickhouse', 'blue'),
      onError: (data, ds) => logToAxiom(data, ds),
    });
```

The `Tracker` class and all its request/session/schema imports move to a **new app file**
`src/server/clickhouse/tracker.ts`, built on top of `clickhouse` from the shim. Its public
import path is preserved for existing call sites. _(Sub-task: extract the exact Tracker
surface from the current `client.ts`; confirm what other modules import from
`~/server/clickhouse/client` so re-exports stay complete.)_

> Future multi-app note: the base client already supports arbitrary inserts; an app that only
> needs "attach a userId" passes it in the row payload — no Tracker required.

---

## 7. `@civitai/axiom` (factory-ize the logger)

`axiom/client.ts` is already free of sibling/app-service imports, but it still reads `env`
directly. Make it a factory for consistency and so other apps get their own datastream/pod
config. `safeError` is pure — export it directly.

```ts
// packages/civitai-axiom/src/client.ts
import { Client } from '@axiomhq/axiom-node';

export type AxiomConfig = {
  token?: string; orgId?: string; datastream?: string;
  podName?: string; isProd: boolean;
  logErrorsToStdout: boolean;                    // process.env.LOG_ERRORS_TO_STDOUT === 'true'
};

export function safeError(e: unknown): MixedObject | undefined { /* unchanged, pure */ }

export function createAxiomLogger(config: AxiomConfig) {
  const axiom = (config.token && config.orgId)
    ? new Client({ token: config.token, orgId: config.orgId }) : null;
  async function logToAxiom(data: MixedObject, datastream?: string) {
    const sendData = { pod: config.podName, ...data };
    if (!config.isProd) { console.log('logToAxiom', sendData); return; }
    if (!axiom) return;
    datastream ??= config.datastream;
    if (!datastream) return;
    if (config.logErrorsToStdout) console.error(JSON.stringify({ _axiom: datastream, ...sendData }));
    await axiom.ingestEvents(datastream, sendData);
  }
  return { logToAxiom, safeError };
}
```

```ts
// src/server/logging/client.ts (app shim — the path db/clickhouse shims import)
import { createAxiomLogger, safeError } from '@civitai/axiom';
import { isProd } from '~/env/other';
import { env } from '~/env/server';

// build guard in the shim: don't construct the Axiom client during `next build`
const noopLog = async (_data: MixedObject, _datastream?: string) => {};
export const logToAxiom = env.IS_BUILD
  ? noopLog
  : createAxiomLogger({
      token: env.AXIOM_TOKEN, orgId: env.AXIOM_ORG_ID, datastream: env.AXIOM_DATASTREAM,
      podName: env.PODNAME, isProd,
      logErrorsToStdout: process.env.LOG_ERRORS_TO_STDOUT === 'true',
    }).logToAxiom;
export { safeError };
```

This shim is the composition seed: the db and clickhouse shims import `logToAxiom` from here
to build their `onSlowQuery` / `onError`. No package imports another package.

---

## 8. `@civitai/telemetry` (helpers stay, pool gauges go back)

`telemetry/client.ts` splits cleanly:

- **Keep in package (no factory needed — pure `prom-client`):** `registerCounter`,
  `registerCounterWithLabels`, `registerGaugeWithLabels`, `registerHistogram`, and the
  HMR-safe `getSingleMetric` fallback. These take no `env` and import no app code.
- **Move back to the app:** the DB pool-depth gauge block
  ([`telemetry/client.ts:~210-296`](../packages/civitai-telemetry/src/client.ts)) that reads
  `pgDbRead.totalCount`, `idleCount`, `waitingCount`, … across all six pools. It **composes**
  `@civitai/db` pools + prom helpers → app-level glue. It originally lived in the app's
  `prom/client.ts`; it returns there and registers gauges using the package's `register*`
  helpers plus the pool singletons from the db shims:

```ts
// src/server/prom/client.ts (app)
import { registerGaugeWithLabels } from '@civitai/telemetry';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { datapacketDbRead } from '~/server/db/datapacketDb';
// …register the node_postgres_pool_* gauges exactly as before…
```

No `@civitai/telemetry → @civitai/db` edge remains.

---

## 9. App composition order

Shims form an acyclic graph (package level has **no** edges; app shims compose upward):

```
@civitai/db-schema  (LEAF: schema + generated Prisma client/types + Kysely types)
        ▲
        │ (generated client/types — downward dep, allowed)
@civitai/db ─────────────────────────────────────────────┐
@civitai/axiom ─▶ src/server/logging/client.ts (logToAxiom)│
                        │                                   │
        ┌───────────────┼───────────────┐                  │
        ▼               ▼               ▼                  ▼
 db/client.ts    clickhouse/client.ts   (onSlowQuery / onError)
 redis/client.ts ─▶ ~/server/flipt/client (isEnhancedFailoverEnabled)
 db/pgDb,notifDb,datapacketDb ─▶ getClient(config)
 prom/client.ts ─▶ @civitai/telemetry + db pool shims
```

There is no `db ↔ redis ↔ clickhouse` import among packages; any historical coupling (e.g.
the old `db-lag-helpers` needing both) lives in app code, which already moved back. The only
cross-package edge is the **downward** `@civitai/db → @civitai/db-schema` (generated types).

---

## 10. Verification checklist (per package, after each refactor commit)

- [ ] `grep -rE "from '~/" packages/<pkg>/src` returns **nothing** (no app imports remain).
- [ ] Package imports only external npm deps + its own `./` files.
- [ ] `pnpm run typecheck` passes (shims satisfy all existing call-site imports).
- [ ] `pnpm run build` (Next standalone) succeeds with `transpilePackages: ['@civitai/*']`.
- [ ] Dev server boots; redis/db/clickhouse connect; HMR does not duplicate clients
      (globals reused).
- [ ] Prom metrics still register once (no duplicate-registration crash on HMR).
- [ ] Slow-query logs still reach Axiom in a prod-like env (`onSlowQuery` wired).

## 11. Open items / decisions

- **@ai:*** `concurrency-helpers.ts` — confirm it's dependency-free so we can vendor it into
  `@civitai/db` rather than inline `limitConcurrency`. (§4.6)
- **@ai:*** Tracker extraction — enumerate exactly what other modules import from
  `~/server/clickhouse/client` today, so the post-split shim re-exports everything callers
  expect. (§6.2)
- **@ai:*** Confirm the `register*` helpers should stay a bare function module (no factory),
  given they hold no per-app config. (§8)
- **@ai:*** Env handling (§2.2): agreed the factories take plain values and never import a
  central `env`. Still open — do we add **per-package scoped env files** (each package ships
  its own zod/`@t3-oss/env` schema + `configFromEnv` helper) now, or keep packages fully
  env-agnostic and let each app own all env validation? Leaning env-agnostic until a second
  app exists, then extract the scoped-env helper only where it pays off.
- **Six packages now**, not five: `@civitai/db-schema` (contract) + `@civitai/db` (Prisma
  runtime) + `redis` + `clickhouse` + `axiom` + `telemetry`. This is distinct from the
  *rejected* `civitai-schema-common` (decision 1 in the handoff) — that was domain constants;
  this is the Prisma-generated DB contract.
- Commit sequencing: pure-move commit first (current staged state **plus** the
  `prisma/`+`enums.ts`+`models.ts` relocation into `@civitai/db-schema`), then one content
  commit per package (db-schema generators → db → redis → clickhouse → axiom → telemetry),
  each independently verifiable.
