# @civitai/db-queries

The monorepo's shared data-access layer: typed Kysely query functions over each app's own Postgres pools,
consumed by the main app and the SvelteKit spokes. Prisma stays the schema/migration source of truth and
generates the `DB` type (`@civitai/db-schema/kysely`); **this package is queries only.**

See [`docs/db-queries-kysely-plan.md`](../../docs/db-queries-kysely-plan.md) for the migration plan.

## Structure

- `src/infra/helpers.ts` — shared query helpers (`jsonArrayFrom`/`jsonObjectFrom` reads, `toJson` writes).
- `src/<domain>.db.ts` — one query module per domain (`reports.db.ts`, `images.db.ts`, …), exported at the
  subpath `@civitai/db-queries/<domain>`.

## Client access — executor injection

**Every query function takes a Kysely client as its first argument** (`db: Kysely<DB>`); the caller decides
which client — read, write, a replica, or an open transaction. The package owns **no** client vars and does
no boot-time wiring (no `connect()`, no globalThis, no proxies). Each app builds its clients over its
**existing** pools and passes them in.

```ts
// query module — src/reports.db.ts
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function setReportStatus(db: Kysely<DB>, input: { id; status; userId }) {
  return db.updateTable('Report').set(/* … */).where('id', '=', input.id).executeTakeFirst();
}
```

```ts
// app — the app owns the clients (main app: src/server/db/kyselyDb.ts) and passes one per call
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
await setReportStatus(kyselyWrite, input);
await getReports(kyselyRead, input);
```

Why first-arg injection rather than an ambient singleton: it makes **transactions compose** (`Transaction<DB>`
satisfies `Kysely<DB>`, so pass a `trx` to run several statements atomically), keeps functions
**tree-shakeable** and trivially testable, and lets routing (read/write/replica/lag-aware) be a per-call
decision instead of frozen into the query. The main-app-only tiers (`kyselyReadLong`, `kyselyDatapacket`) are
just clients the app can choose to pass; a spoke that never builds them simply never passes them.

**Binding once per scope (optional sugar):** if passing `db` at every call site is noisy in a hot handler, an
app can wrap a domain — `const reports = createReportsRepo(db)` returning `db`-free methods — so `db` appears
once per request/transaction. Keep this as an **app-local** convenience; the package exports plain
functions (a factory object closing over every builder would defeat tree-shaking).

## Authoring conventions

- **Imports**: named imports only — no `import * as`.
- **Function shape** — every exported query function follows the same signature so call sites read uniformly:
  - **First parameter is always `db: Kysely<DB>`** — the executor the caller supplies (see Client access). A
    compose function passes its `db` (or a `trx` it opens) through to each callee.
  - **Inputs after `db`**: a single `input` object for anything with **two or more fields or any optional
    field** — `setReportStatus(db, { id, status, userId })`. This is what makes `insertUserCosmeticGrant(db,
{ userId, cosmeticIds })` right and `(db, userId, cosmeticIds)` wrong. **Never take two or more positional
    data args.** A lone required id/array may be positional (`getImage(db, imageId)`, `getImages(db, ids)`) —
    don't wrap a single value just for ceremony.
  - **Always execute** — end the builder in `.execute()` / `.executeTakeFirst()` (or `sql\`…\`.execute(db)`) and
return the result/`Promise`. Do **not** return an un-executed query builder for the caller to run; it
    breaks the uniform call shape and hides the execution point.
- **Prefer a generic `update<Entity>` over narrow single-column setters.** Each entity has one
  `update<Entity>(db, input: Updateable<DB['<Entity>']> & { id: number })` (`{ id, ...data }`), which stamps
  `updatedAt` automatically when the table has an `@updatedAt` column, and a `update<Entity>Many(db, { ids } &
  Updateable<…>)` bulk variant where needed (guarding the empty-id case). A trivial `SET <one column> WHERE id`
  belongs at the call site as `updateX(db, { id, <col>: value })`, **not** a bespoke `set<Entity><Column>`
  function. Keep a named function only when it (a) sets **two or more** columns as a specific semantic
  transition (e.g. `setImageAppealRestored`), (b) needs a jsonb/`CASE`/expression or stored-proc write (the
  generic sets columns raw — a jsonb column must go through `toJson()`, so it can't collapse), (c) toggles /
  negates a column, or (d) keys on something other than `id`.
- **Method names: `<verb><Entity>[Qualifier]`** — entity-prefixed so each name is self-identifying at the
  call site.
  - **Verbs**: `get` / `list` / `count` for reads; `set` / `upsert` / `insert` / `delete` for writes.
  - **Singular entity + `Many` for bulk** — a bulk variant keeps the entity **singular** and appends `Many`:
    `setReportStatus` → `setReportStatusMany` (not `setReportsStatusMany`).
  - Examples: `getReportReporters`, `setReportStatus`, `setReportStatusMany`.
- **Name collisions**: a db method may share a name with a higher-level service function (e.g. the spoke's
  `setReportStatus` service wraps the db `setReportStatus`). Resolve with a local import alias in that file —
  `import { setReportStatus as setReportStatusDb }` — the package export stays canonical.
- **Transactions**: native Kysely. A compose function takes `db` and opens the transaction on it —
  `db.transaction().execute((trx) => …)` — passing `trx` as the first arg to each statement function
  (`Transaction<DB>` satisfies `Kysely<DB>`). Prefer a single atomic statement (e.g. bulk `UPDATE … WHERE id
IN (…) RETURNING`) where it suffices. Kysely and Prisma transactions do **not** compose — migrate whole
  transactional units together.
- **Read-your-writes**: the caller picks the client. The main app's `getKyselyWithoutLag(type, id)` returns the
  lag-correct client (read or write) via the shared lag tracker; pass its result as the query's `db`.

## Reads — nested relations

Replace a Prisma `include`/nested `select` with `jsonArrayFrom`/`jsonObjectFrom` (re-exported from this
package). They build a correlated `jsonb` subquery and the result type is **inferred** — no hand-authored
selector/GetPayload type. Postgres parses the jsonb itself (no result-parsing plugin needed).

```ts
import { jsonArrayFrom } from '@civitai/db-queries';
db.selectFrom('Model').select((eb) => [
  'Model.id',
  'Model.name',
  jsonArrayFrom(
    eb
      .selectFrom('ModelVersion')
      .select(['id', 'name'])
      .whereRef('ModelVersion.modelId', '=', 'Model.id')
  ).as('versions'),
]); // inferred: { id; name; versions: { id; name }[] }[]
```

**Gotcha**: dates/bigints nested inside the json come back as **strings** (JSON serialization) even though the
inferred type says `Date`/`number`. Parse those fields where a real `Date`/`bigint` is needed.

## Writes — Prisma-parity gotchas

- **jsonb columns**: wrap the value in `toJson()`. node-postgres serializes a plain object fine but turns a JS
  array into a Postgres array literal (`{1,2}`) — wrong for jsonb. `toJson()` is unambiguous for both:
  `.set({ meta: toJson(metaObject) })`.
- **`@updatedAt` columns are NOT auto-set.** Prisma bumped them client-side; Kysely does not, and there is no
  DB trigger. A ported `UPDATE` must set it explicitly (`.set({ ..., updatedAt: new Date() })`) OR the app must
  install the shared updated-at plugin / DB trigger before porting write-heavy domains (see the plan doc).
- **Nested writes** (Prisma `connect`/`connectOrCreate`/nested `create`): decompose into explicit statement
  functions, and have a compose function open `db.transaction().execute((trx) => …)` and pass `trx` as each
  statement's `db`.

## Correctness rules

- **Guard empty arrays before `where('col', 'in', arr)`.** Kysely compiles `in ([])` to `IN ()`, a Postgres
  **syntax error** (Prisma silently no-op'd). Any bulk query taking an id/array input must short-circuit:
  `if (!input.ids.length) return [];` before executing. (See `setReportStatusMany`.)

## Testing

Every query gets a test. There are two tiers — the first is required, the second is required for hot paths:

Run the in-package tests with `pnpm --filter @civitai/db-queries test` (Vitest; `test:watch` to iterate).
They are wired into CI the same way the other packages' `vitest run` scripts are.

### 1. Compiled-SQL tests (required, no DB)

Assert the **exact SQL + parameters** a query function compiles to. This is the cheap, deterministic guard
that runs in CI with no database: it catches a refactor that silently drops a `where` filter, reorders a
`set` clause, or would emit `IN ()` for an empty array. Use the offline harness in
[`src/test/harness.ts`](src/test/harness.ts) — `compileHarness()` returns a `db` (a Kysely `DummyDriver`
client) you pass to the query; `.execute()` compiles the SQL (captured via the `log` hook) and resolves to an
empty result without a pool.

```ts
import { compileHarness } from './test/harness';
import { setReportStatusMany } from './reports.db';

const h = compileHarness();

it('bulk-updates the given ids in one statement', async () => {
  await setReportStatusMany(h.db, { ids: [1, 2, 3], status: 'Actioned', userId: 99 });
  const { sql, parameters } = h.lastQuery();
  expect(sql).toContain('where "id" in ($4, $5, $6)');
  expect(sql).not.toContain('in ()');
  expect(parameters).toEqual(['Actioned', expect.any(Date), 99, 1, 2, 3, 'Actioned']);
});

it('short-circuits an empty id list without touching the DB', async () => {
  const result = await setReportStatusMany(h.db, { ids: [], status: 'Actioned', userId: 99 });
  expect(result).toEqual([]);
  expect(h.queries).toHaveLength(0); // the empty-array guard the correctness rules require
});
```

See [`src/reports.db.test.ts`](src/reports.db.test.ts) for the full example (Actioned vs non-Actioned set
clauses, the single-row `setReportStatus`, and the empty-array guard).

### 2. Behavior + execution-plan checks (required for hot paths, needs a live DB)

The compiled-SQL test proves _what_ SQL runs, not that it's valid against the real schema. `explainHarness()`
gives you a `db` (still the DummyDriver, so passing it to a query COMPILES without executing — safe for
writes) plus `explainLast()`/`explainAll()`, which `EXPLAIN` (no ANALYZE) the compiled SQL against a live
Postgres: it parses + plans the statement without running it, so a query whose columns/joins/types/proc
signatures don't resolve fails here even though the compile test passed. Env-gated (`TEST_DATABASE_URL`, or
the root `.env` `DATABASE_URL` locally); the suite `describe.skipIf(!h.hasDb)`-skips when no DB is reachable.
Wrap it and destroy the client in `afterAll`. See [`src/reports.db.explain.test.ts`](src/reports.db.explain.test.ts).
Stricter plan-regression assertions (no seq-scan on a hot path) need a prod-like dataset — dev-DB planner
choices vary with table size — so keep those against real data, not this suite.

## Example

```ts
// src/reports.db.ts
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Single: transition one report, RETURNing the reporters only if it actually changed.
export function setReportStatus(
  db: Kysely<DB>,
  input: { id: number; status: ReportStatusValue; userId: number }
) {
  return db
    .updateTable('Report')
    .set(/* … */)
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}

// Bulk: same transition across many reports in one atomic statement (no explicit transaction).
export function setReportStatusMany(
  db: Kysely<DB>,
  input: { ids: number[]; status: ReportStatusValue; userId: number }
) {
  if (!input.ids.length) return []; // guard: Kysely compiles `in ([])` to `IN ()` (a syntax error)
  return db
    .updateTable('Report')
    .set(/* … */)
    .where('id', 'in', input.ids)
    .where('status', '!=', input.status)
    .returning(['id', 'userId', 'alsoReportedBy'])
    .execute();
}
```
