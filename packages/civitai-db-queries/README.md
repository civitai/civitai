# @civitai/db-queries

The monorepo's shared data-access layer: typed Kysely query functions over each app's own Postgres pools,
consumed by the main app and the SvelteKit spokes. Prisma stays the schema/migration source of truth and
generates the `DB` type (`@civitai/db-schema/kysely`); **this package is queries only.**

See [`docs/db-queries-kysely-plan.md`](../../docs/db-queries-kysely-plan.md) for the migration plan.

## Structure

- `src/infra/client.ts` — the Kysely client vars + `connect()`.
- `src/infra/helpers.ts` — shared query helpers (`jsonArrayFrom`/`jsonObjectFrom` reads, `toJson` writes).
- `src/<domain>.db.ts` — one query module per domain (`reports.db.ts`, `images.db.ts`, …), exported at the
  subpath `@civitai/db-queries/<domain>`.

## Wiring (once per app, at boot)

The package owns the client vars; each app builds Kysely clients over its **existing** pools and hands them
to `connect()` — no new pools or connections:

```ts
// main app — rides the existing pgDb / datapacketDb pools
connect({ read, write, readLong, datapacket });
// spoke — readLong/datapacket omitted
connect({ read, write });
```

`connect()` runs at server start (main app: `instrumentation.node.ts`; spoke: `db.ts`) and stores the clients
on `globalThis`. The client vars are lazy proxies that resolve through that `globalThis` cell on each use —
so they are correct even if a bundler emits more than one copy of this module, survive dev HMR, and don't
depend on module-init order. (Do not replace the proxies with a plain `let` — that reintroduces the
duplication bug.)

## Client tiers

`kyselyRead`, `kyselyWrite`, `kyselyReadLong`, `kyselyDatapacket`. A query module imports the tier it needs
directly. `readLong`/`datapacket` are **main-app-only** — the spoke never provides them, so a query that uses
them throws there; keep such queries main-app-only. For dynamic per-call routing, select among the vars
inside the query (see the plan doc's `image.service` example).

## Authoring conventions

- **Imports**: named imports only — no `import * as`.
- **Method names: `<verb><Entity>[Qualifier]`** — entity-prefixed so each name is self-identifying at the
  call site.
  - **Verbs**: `get` / `list` / `count` for reads; `set` / `upsert` / `insert` / `delete` for writes.
  - **Singular entity + `Many` for bulk** — a bulk variant keeps the entity **singular** and appends `Many`:
    `setReportStatus` → `setReportStatusMany` (not `setReportsStatusMany`).
  - Examples: `getReportReporters`, `setReportStatus`, `setReportStatusMany`.
- **Name collisions**: a db method may share a name with a higher-level service function (e.g. the spoke's
  `setReportStatus` service wraps the db `setReportStatus`). Resolve with a local import alias in that file —
  `import { setReportStatus as setReportStatusDb }` — the package export stays canonical.
- **Transactions**: native Kysely — `kyselyWrite.transaction().execute((trx) => …)`. Pass `trx` explicitly to
  functions that must participate; prefer a single atomic statement (e.g. bulk `UPDATE … WHERE id IN (…)
  RETURNING`) where it suffices. Kysely and Prisma transactions do **not** compose — migrate whole
  transactional units together.
- **Read-your-writes**: use the main app's `getKyselyWithoutLag(type, id)`, which returns these client vars
  via the shared lag tracker.

## Reads — nested relations

Replace a Prisma `include`/nested `select` with `jsonArrayFrom`/`jsonObjectFrom` (re-exported from this
package). They build a correlated `jsonb` subquery and the result type is **inferred** — no hand-authored
selector/GetPayload type. Postgres parses the jsonb itself (no result-parsing plugin needed).

```ts
import { jsonArrayFrom } from '@civitai/db-queries';
kyselyRead.selectFrom('Model').select((eb) => [
  'Model.id', 'Model.name',
  jsonArrayFrom(
    eb.selectFrom('ModelVersion').select(['id', 'name']).whereRef('ModelVersion.modelId', '=', 'Model.id'),
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
- **Nested writes** (Prisma `connect`/`connectOrCreate`/nested `create`): decompose into explicit statements
  inside `kyselyWrite.transaction().execute((trx) => …)`. A transaction-composable write takes an optional
  `trx` and runs on `trx ?? kyselyWrite`.

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
[`src/test/harness.ts`](src/test/harness.ts) — it wires the client vars to a Kysely `DummyDriver` so
`.execute()` compiles the SQL (captured via the `log` hook) and resolves to an empty result without a pool.

```ts
import { connectCompileOnly } from './test/harness';
import { setReportStatusMany } from './reports.db';

const harness = connectCompileOnly(); // calls connect() with the offline client

it('bulk-updates the given ids in one statement', async () => {
  await setReportStatusMany({ ids: [1, 2, 3], status: 'Actioned', userId: 99 });
  const { sql, parameters } = harness.lastQuery();
  expect(sql).toContain('where "id" in ($4, $5, $6)');
  expect(sql).not.toContain('in ()');
  expect(parameters).toEqual(['Actioned', expect.any(Date), 99, 1, 2, 3, 'Actioned']);
});

it('short-circuits an empty id list without touching the DB', async () => {
  const result = await setReportStatusMany({ ids: [], status: 'Actioned', userId: 99 });
  expect(result).toEqual([]);
  expect(harness.queries).toHaveLength(0); // the empty-array guard the correctness rules require
});
```

See [`src/reports.db.test.ts`](src/reports.db.test.ts) for the full example (Actioned vs non-Actioned set
clauses, the single-row `setReportStatus`, and the empty-array guard).

### 2. Behavior + execution-plan checks (required for hot paths, needs a live DB)

The compiled-SQL test proves *what* SQL runs, not *how Postgres runs it*. For any list/feed/hot-path query —
especially the lateral-subquery form of `jsonArrayFrom`, which executes differently from Prisma's include —
run the compiled SQL against a real database, assert the **result shape** (remember: dates/bigints nested in
json come back as strings), and `EXPLAIN` it to fail on plan regressions (seq scans on hot paths, missing
index usage, nested-json subquery cost). These live with the consuming app's DB-backed tests / the
`postgres-query` skill, not in the no-DB unit run above — grab the SQL with `query.compile()` and paste it
into `EXPLAIN (ANALYZE, BUFFERS)`.

## Example

```ts
// src/reports.db.ts
import { kyselyWrite } from './infra/client';

// Single: transition one report, RETURNing the reporters only if it actually changed.
export function setReportStatus(input: { id: number; status: ReportStatusValue; userId: number }) {
  return kyselyWrite
    .updateTable('Report')
    .set(/* … */)
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}

// Bulk: same transition across many reports in one atomic statement (no explicit transaction).
export function setReportStatusMany(input: { ids: number[]; status: ReportStatusValue; userId: number }) {
  return kyselyWrite
    .updateTable('Report')
    .set(/* … */)
    .where('id', 'in', input.ids)
    .where('status', '!=', input.status)
    .returning(['id', 'userId', 'alsoReportedBy'])
    .execute();
}
```
