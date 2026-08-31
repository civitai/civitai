# Kysely query package (`@civitai/db-queries`) — migration plan

> Status: **v2 draft, for discussion.** Comment inline with `@dev:` / `@ai:`.
> Scaffold exists (uncommitted): `packages/civitai-db-queries/`, `src/server/db/kyselyDb.ts`,
> `getKyselyWithoutLag`, the `bulkSetReportStatus` repoint, and the moderator spoke's `setReportStatus`.

## Goal

Make `@civitai/db-queries` the **single data-access layer** for the monorepo: all DB reads/writes live here
as typed Kysely query functions, consumed by both the main app and the SvelteKit spokes. Prisma stops being
the query API.

**Prisma does not go away** — it drops to schema source of truth, migrations (applied manually), and
generating the Kysely `DB` type (`@civitai/db-schema/kysely`, via prisma-kysely). End state: **Prisma for
schema + migrations + type generation; Kysely for every query.**

### Why

- The main app already runs huge amounts of **untyped** SQL via `pgDb.query(\`…\`)`and`$queryRaw`. Kysely
  replaces those strings with type-checked queries generating the same SQL — a strict upgrade.
- One query API instead of Prisma + `pgDb` raw + `$queryRaw` sprawl.
- Query logic becomes **shareable** across apps (the moderator spoke already reimplements main-app logic in
  Kysely; this stops the hand-porting and the drift).

## Scope — full query migration

- **All** reads and writes move to Kysely — including nested relation reads (via `jsonArrayFrom`/
  `jsonObjectFrom`, result types **inferred** — no selector/GetPayload rewrite) and nested writes (decomposed
  into explicit Kysely transactions). Prisma is retained ONLY for the schema, migrations, and generating the
  Kysely `DB` type; it is no longer a query API.
- Not removing Prisma-as-schema, and not touching the migration workflow.
- Not a big-bang cutover — incremental, domain-by-domain, coexisting with Prisma for a long time.

## Architecture — deliberately simple

### Executor injection: every query takes the client as its first argument

The package owns **no** client vars and does no boot-time wiring (no `connect()`, no globalThis, no proxies).
Every query function takes `db: Kysely<DB>` as its first parameter; the **caller** decides which client — read,
write, a replica, or an open transaction. Each app builds its clients over its **existing** pools and passes
one in per call.

```ts
// packages/civitai-db-queries/src/reports.db.ts — db-first, cross-app
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function setReportStatus(db: Kysely<DB>, input) {
  return db
    .updateTable('Report')
    .set(/* … */)
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}
```

```ts
// main app — src/server/db/kyselyDb.ts (rides the EXISTING pgDb / datapacketDb pools; no new connections)
const { dbRead, dbWrite } = createKyselyClients<DB>({ pool: pgDbWrite, readPool: pgDbRead });
export const kyselyRead = dbRead;
export const kyselyWrite = dbWrite;
export const kyselyReadLong = createKyselyClients<DB>({
  pool: pgDbReadLong,
  singleClient: true,
}).db;
export const kyselyDatapacket = createKyselyClients<DB>({
  pool: datapacketDbRead,
  singleClient: true,
}).db;

// call site: await setReportStatus(kyselyWrite, input);
// spoke owns its own dbRead/dbWrite the same way; readLong/datapacket simply never get passed there.
```

Why db-first rather than an ambient singleton: transactions **compose** (see below), functions stay
**tree-shakeable** (`"sideEffects": false`; import one query from a big domain module, bundle only that query)
and trivially testable (pass a client — no global to mutate), and read/write/replica/lag routing is a per-call
decision instead of frozen into the query. If passing `db` at every call site is noisy, an app can add a
thin **local** binder (`createReportsRepo(db)` → `db`-free methods) so `db` appears once per scope; keep it
app-side (a factory closing over every builder would defeat tree-shaking).

### Transactions — native Kysely, no magic

A compose function takes `db` and opens the transaction on it — `await db.transaction().execute(async (trx) =>
{ … })` — passing `trx` as the first arg to each statement function (`Transaction<DB>` satisfies `Kysely<DB>`,
so the same functions work inside or outside a transaction). Where a single atomic statement suffices (e.g. a
bulk `UPDATE … WHERE id IN (…) RETURNING`), no transaction is needed — that's the `bulkSetReportStatus` repoint
(`setReportStatusMany`). **Prisma and Kysely transactions still don't compose**, so migrate whole
transactional units together.

### Lag / read-your-writes — reuse the existing helpers

The lag decision is just a boolean (`lagTracker.isStale`), so the Kysely twin **returns the client** the
caller then passes as `db`:

```ts
// main app db-lag-helpers.ts — beside getDbWithoutLag, same lagTracker; kyselyRead/Write from kyselyDb.ts
export async function getKyselyWithoutLag(type?, id?) {
  if (env.REPLICATION_LAG_DELAY <= 0) return kyselyRead;
  if (type === undefined || id === undefined)
    return isHighReplicationLagMode() ? kyselyWrite : kyselyRead;
  return (await lagTracker.isStale(lagKey(type, id))) ? kyselyWrite : kyselyRead;
}
// call site: const db = await getKyselyWithoutLag('model', id); await getModel(db, input);
```

The write side (`preventReplicationLag`/`markFresh`) is shared and unchanged.

### Dynamic, per-call routing (`image.service.ts:1306`)

Some queries pick their pool from caller input + query shape + a Flipt flag. That routing now lives at the
**call site** (or a thin wrapper), which selects a client and passes it as `db`:

```ts
let dbTarget = input.dbTarget ?? 'read';
if (
  joinsImageResourceNew &&
  dbTarget !== 'write' &&
  (await isFlipt(FLIPT.IMAGE_RESOURCE_USE_WRITE))
)
  dbTarget = 'write';
const imageDb =
  dbTarget === 'write' ? kyselyWrite : dbTarget === 'datapacket' ? kyselyDatapacket : kyselyRead;
await getImages(imageDb, input); // was: pgDbWrite / datapacketDbRead / pgDbRead
```

`datapacket` is a **same-schema read replica** (the code runs the same feed query against it), so it's just
another client the caller can pass — not a separate database/binding.

### Package organization & conventions

One package, **subpath per domain** (`src/<domain>.db.ts`), with infra (`src/infra/client.ts`) separate from
domain queries. Split into multiple packages only if one becomes unwieldy.

Authoring conventions (structure, `<verb><Entity>[Qualifier]` naming incl. singular-entity `+ Many` for bulk,
named imports, collision aliasing, transactions) are the **canonical reference** in the package README:
[`packages/civitai-db-queries/README.md`](../../packages/civitai-db-queries/README.md). Keep it as the single
source of truth so this plan and the code don't drift.

## Migration strategy

1. **Raw-and-complex first.** Port the already-**untyped** `pgDb.query`/`$queryRaw` sites first — biggest ROI
   (untyped → typed, same SQL, no behavior change).
2. **Whole transactional units at once.** Never split a unit of work across Prisma and Kysely.
3. **Domain by domain**, each behind its own subpath, each verified (re-EXPLAIN converted raw SQL; typecheck
   both apps).
4. **Shared-first opportunism.** When a spoke needs a query the main app has, write it once here and repoint
   both.

## Guardrails

- The `DB` type is generated from `schema.prisma` — keep the regen wired so queries can't drift from columns.
- Kysely rides existing `pgDb` pools (no new pool); watch pool sizing/gauges as volume shifts off Prisma's
  engine onto `pgDb`.
- **Correctness rules Prisma used to handle for us** — each is a real silent-corruption or crash risk if
  missed; enforced via the README + review:
  - jsonb writes go through `toJson()` (node-postgres mis-serializes a JS array to jsonb).
  - `@updatedAt` (79 columns) is **not** auto-set by Kysely — set it explicitly, or install an updated-at
    plugin / DB trigger before porting write-heavy domains.
  - guard empty arrays before `where(col,'in',arr)` (Kysely emits `IN ()`, a syntax error; Prisma no-op'd).
  - dates/bigints nested inside `jsonArrayFrom` json come back as strings — parse per-field.
- **Test every query for behavior AND execution plan.** Assert `EXPLAIN` output so a port can't silently
  introduce a seq scan or drop an index — especially the lateral-subquery form of `jsonArrayFrom` on hot
  feeds. Read/write patterns live in the [package README](../../packages/civitai-db-queries/README.md).

## Phased plan

- **Phase 0 — Foundation** _(scaffolded)._ Executor-injection convention (every query takes `db: Kysely<DB>`
  first), the main-app `kyselyDb.ts` that owns the clients over existing pools, `getKyselyWithoutLag`, the json
  read/`toJson` write helpers, and `reports` (`setReportStatus`/`setReportStatusMany`) as the reference.
  Consumers: spoke `setReportStatus`, main-app `bulkSetReportStatus`.
- **Phase 1 — Raw-SQL beachhead.** Port a first high-value raw-SQL cluster to typed Kysely as the
  pattern-setter.
- **Phase 2 — Domain rollout.** Port domain by domain, transactional-units-whole, subpath by subpath.
- **Phase 3 — Convergence.** Prisma reduced to schema/migrations/type-gen; queries live in the package.

## Moderator-app migration status

The moderator app (`apps/moderator`, a separate checkout) already writes typed Kysely against the same
`@civitai/db-schema/kysely` `DB` type, so porting is mostly mechanical: lift the **pure Postgres query cores**
into `@civitai/db-queries/<domain>` (each function takes the app's client as its first `db` argument instead
of reaching a `dbRead`/`dbWrite` singleton),
leaving side-effects (mod-activity logging, search-index sync, cache busts, notifications, rewards, redis,
emails, orchestrator calls) in the app service, which calls the ported query. Heavily-mixed functions are
**decomposed into one pure statement per fn** (e.g. `image-moderation`'s `acceptImage` → `getImageForModeration`

- `setImageAccepted` + `deleteImageTagsForReview` + `recomputeImageNsfwLevel` + …), each `trx?`-composable so
  the app re-assembles the original transaction. The app-side switch to consume the package lands **after** this
  merges to `main` and the moderator app pulls it in.

**Ported (19 modules, ~60 query fns, each with compile-SQL + DB-backed EXPLAIN tests):** `reports`, `users`,
`model3d`, `cosmetics`, `mod-activity`, `comics`, `ingestion`, `blocklist`, `image-rating-review`,
`image-review`, `image-moderation`, `image-moderation-effects`, `image-tags`, `articles`,
`article-rating-review`, `scanner`, `tags-on-image`, `sidebar-counts`, `rewards`. Each is exported at its
`@civitai/db-queries/<domain>` subpath.

**Out of scope — ClickHouse (deliberately not ported).** `@civitai/db-queries` is Postgres/Kysely-only; the
following moderator queries are ClickHouse and stay in the app (or await a future CH mechanism), listed so
nothing is silently dropped:

- Whole CH-driven files: `page-visits.ts` (`recordPageVisit`, `getPageVisitSummary`, `getRouteUserBreakdown`),
  `prohibited-prompts.service.ts` (`getTodaysProhibitedPrompts`, `getTodaysProhibitedUserCounts`),
  `downleveled-review.service.ts` (`getDownleveledImages`). Their incidental PG id-enrichment reads were not
  extracted (low standalone value without the CH driver).
- CH functions inside otherwise-ported domains: `scanner` (`listScans`, `focusedRun`, `getActiveLabels` cores),
  `rewards` (`rewardReportReporters` CH+redis; `getBaseRewardsMultiplier` redis), `image-moderation-effects`
  (`addImagesToBlocklist`/`removeImagesFromBlocklist` and the `trackImageDeleteTos` analytics insert),
  `image-review` (`getAppealImageQueue`'s `tosReason` CH enrich — field returned `null`, left to the app).

**Testing note.** Every ported query has a compile-SQL test (exact SQL + params, offline) and a DB-backed
`EXPLAIN` test (validates columns/joins/types/proc-signatures against the live schema; env-gated, skips with no
DB). A few secondary hydration queries that only fire when a primary query returns rows are compile-tested but
not EXPLAIN-covered under the offline harness (noted in-file) — extract them to standalone fns if stricter
coverage is wanted.

## Open decisions — need `@dev:`

1. **CRUD end-state.** ~~Port everything or scope to raw+complex?~~ **Resolved: FULL migration.** Nested reads
   port via `jsonArrayFrom`/`jsonObjectFrom` (types inferred — no selector/GetPayload rewrite); nested writes
   port as explicit Kysely transactions. Prisma retained only for schema/migrations/type-gen.
2. **First beachhead.** Which raw-SQL cluster is the Phase-1 pattern-setter? A smaller, **fully-typeable** raw
   cluster is safer than `image.service` (whose targets include non-modeled objects — materialized views /
   metric tables — plus the hard dynamic routing). `@dev:*`
3. **Package boundary.** One `@civitai/db-queries` with subpaths (recommended) vs per-domain packages.
   `@dev:*`
4. **Client access.** ~~`connect()` + globalThis proxies vs live-binding?~~ **Resolved: executor injection —
   every query takes `db: Kysely<DB>` as its first arg; the app owns the clients (`kyselyDb.ts`) and passes one
   per call.** No `connect()`/globalThis/proxy machinery (deleted). Chosen for composable transactions,
   tree-shaking, and per-call routing; an app can add a local `createXRepo(db)` binder if per-call `db` passing
   is noisy. `@dev:*`
