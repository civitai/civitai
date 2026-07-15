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

- The main app already runs huge amounts of **untyped** SQL via `pgDb.query(\`…\`)` and `$queryRaw`. Kysely
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

### The package owns the client vars; each app connects them once

No injection ceremony, no per-query accessors. The package exports the Kysely clients as module vars; each
app calls `connect()` **once at boot**, handing over clients it built over its **existing** pools — so no new
pools or connections are created.

```ts
// packages/civitai-db-queries/src/infra/client.ts
// connect() stores the clients on globalThis; the exported vars are lazy proxies that resolve through it — so
// they're correct even if a bundler emits multiple copies of this module (Next instrumentation vs routes),
// survive HMR, and don't depend on init order. Query modules just `import { kyselyWrite }` and use it.
export const kyselyRead: Kysely<DB>;        // proxy → globalThis clients.read
export const kyselyWrite: Kysely<DB>;       // proxy → globalThis clients.write
export const kyselyReadLong: Kysely<DB>;    // main-app-only tiers (throw in the spoke, which never provides them)
export const kyselyDatapacket: Kysely<DB>;
export function connect(clients): void;     // called once per app at boot
```

```ts
// main app — src/server/db/kyselyDb.ts  (rides the EXISTING pgDb / datapacketDb pools; imported at boot)
connect({
  read:  createKyselyClients<DB>({ pool: pgDbWrite, readPool: pgDbRead }).dbRead,
  write: createKyselyClients<DB>({ pool: pgDbWrite, readPool: pgDbRead }).dbWrite,
  readLong:   createKyselyClients<DB>({ pool: pgDbReadLong,     singleClient: true }).db,
  datapacket: createKyselyClients<DB>({ pool: datapacketDbRead, singleClient: true }).db,
});

// spoke — db.ts  (its own clients; readLong/datapacket left undefined)
connect({ read: dbRead, write: dbWrite });
```

`connect()` sets ESM live bindings at boot; queries read them at request time, so the vars are always
populated when a query runs. Each process connects with its own clients — cross-app sharing is *code* reuse
(same query modules), not shared connections.

### Queries import the vars directly

```ts
// packages/civitai-db-queries/src/reports.db.ts  — zero-arg, cross-app
import { kyselyWrite } from './infra/client';
export function setReportStatus(input) {
  return kyselyWrite.updateTable('Report').set(/* … */).where('id', '=', input.id)
    .where('status', '!=', input.status).returning(['userId', 'alsoReportedBy']).executeTakeFirst();
}
```

### Transactions — native Kysely, no magic

`await kyselyWrite.transaction().execute(async (trx) => { … use trx … })`. A query that must run inside a
transaction takes an explicit `trx`; most queries don't need one. Where a single atomic statement suffices
(e.g. a bulk `UPDATE … WHERE id IN (…) RETURNING`), no transaction is needed at all — that's how the
`bulkSetReportStatus` repoint works (`setReportStatusMany`). **Prisma and Kysely transactions still don't
compose**, so migrate whole transactional units together.

### Lag / read-your-writes — reuse the existing helpers

The lag decision is just a boolean (`lagTracker.isStale`), so the Kysely twin returns the package's client
vars with the same logic:

```ts
// main app db-lag-helpers.ts — beside getDbWithoutLag, same lagTracker
export async function getKyselyWithoutLag(type?, id?) {
  if (env.REPLICATION_LAG_DELAY <= 0) return kyselyRead;
  if (type === undefined || id === undefined) return isHighReplicationLagMode() ? kyselyWrite : kyselyRead;
  return (await lagTracker.isStale(lagKey(type, id))) ? kyselyWrite : kyselyRead;
}
```

The write side (`preventReplicationLag`/`markFresh`) is shared and unchanged.

### Dynamic, per-call routing (`image.service.ts:1306`)

Some queries pick their pool from caller input + query shape + a Flipt flag. That routing logic stays *in the
query* and just selects among the package vars — a straight find-replace of the concrete pools:

```ts
let dbTarget = input.dbTarget ?? 'read';
if (joinsImageResourceNew && dbTarget !== 'write' && (await isFlipt(FLIPT.IMAGE_RESOURCE_USE_WRITE)))
  dbTarget = 'write';
const imageDb = dbTarget === 'write' ? kyselyWrite : dbTarget === 'datapacket' ? kyselyDatapacket : kyselyRead;
// was: … ? pgDbWrite : … ? datapacketDbRead : pgDbRead
```

`datapacket` is a **same-schema read replica** (the code runs the same feed query against it), so it's just
another client var — not a separate database/binding.

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

- **Phase 0 — Foundation** *(scaffolded).* Package client vars (globalThis proxies) + `connect`, the main-app
  `kyselyDb.ts` over existing pools, `getKyselyWithoutLag`, the json read/`toJson` write helpers, and `reports`
  (`setReportStatus`/`setReportStatusMany`) as the reference. Consumers: spoke `setReportStatus`, main-app
  `bulkSetReportStatus`.
- **Phase 1 — Raw-SQL beachhead.** Port a first high-value raw-SQL cluster to typed Kysely as the
  pattern-setter.
- **Phase 2 — Domain rollout.** Port domain by domain, transactional-units-whole, subpath by subpath.
- **Phase 3 — Convergence.** Prisma reduced to schema/migrations/type-gen; queries live in the package.

## Open decisions — need `@dev:`

1. **CRUD end-state.** ~~Port everything or scope to raw+complex?~~ **Resolved: FULL migration.** Nested reads
   port via `jsonArrayFrom`/`jsonObjectFrom` (types inferred — no selector/GetPayload rewrite); nested writes
   port as explicit Kysely transactions. Prisma retained only for schema/migrations/type-gen.
2. **First beachhead.** Which raw-SQL cluster is the Phase-1 pattern-setter? A smaller, **fully-typeable** raw
   cluster is safer than `image.service` (whose targets include non-modeled objects — materialized views /
   metric tables — plus the hard dynamic routing). `@dev:*`
3. **Package boundary.** One `@civitai/db-queries` with subpaths (recommended) vs per-domain packages.
   `@dev:*`
4. **`connect()` wiring.** ~~Live-binding through both bundlers?~~ **Resolved: the clients are stored on
   `globalThis` and read via lazy proxies** (bundle-duplication / HMR / boot-order safe) — no `export let`
   live-binding dependency. Still worth a dev smoke test of one end-to-end query per app before Phase 1.
   `@dev:*`
