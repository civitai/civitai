# The `dbRead`/`dbWrite` alias split where the service picks its client at runtime

**Status (added 2026-08-21):** Historical analysis. Bucket classifications were verified at branch base `17f994221e`; the 6 files and their routing defaults are documented per-case.

Written by josh, 2026-08-15, for the `src/server/services/__tests__` a–m slice of the shared-mock
migration (branch `perf/test-mock-migration-services-a-m`). These are the buckets in that slice
where the routing decision is **not** readable off the production source in the usual way, so it is
written up per case rather than handed over as a to-do list.

## Mechanism 1: the client is a PARAMETER

Most files that mock `~/server/db/client` with one local serving both clients —

```ts
vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
```

— can be split by reading the module under test: find `dbRead.model.method` or
`dbWrite.model.method` and bind accordingly. Two things break that here.

**1. `block-registry.service.ts` takes its client as a parameter.** Five call sites do

```ts
const db = opts.db === 'read' ? dbRead : dbWrite; // :1362, :1819, :1887, :1928
const db = opts?.db === 'write' ? dbWrite : dbRead; // :2032  — note the INVERTED default
```

and pass `db` down (`applyPinnedVersion(live, appBlockId, pinnedVersion, db)`). So a grep for
`dbRead.appBlockPublishRequest.findFirst` finds **nothing**, and the client a given test exercises
is a fact about the _test's_ call, not about the service.

**2. Routing an alias wrongly is silent for a negative assertion.** A positive assertion goes red
when the call lands on the other node. `expect(mockDb.appBlockReview.create).not.toHaveBeenCalled()`
passes **trivially** if `create` is routed to the client the code never touches. These six files
carry 14 such assertions, so a wrong guess is not caught by running the suite.

## The resolution, and a correction to my earlier claim

I reported these as needing a per-test decision and possibly permanent hand-work. **Having read
them, that is too pessimistic: every case here is statically determinable, because no test in the
six passes a `db` option at all.** Verified by grepping each file for `db: 'read'` / `db: 'write'` —
zero hits. So each entry point falls to its own default, and those defaults are fixed:

| entry point                          | client when no `db` option is passed                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `BlockRegistry.resolveBlockInstance` | **`dbWrite`** (`opts.db === 'read' ? dbRead : dbWrite`)                                         |
| `BlockRegistry.applyPinnedVersion`   | inherits the caller's — from `resolveBlockInstance`, **`dbWrite`**                              |
| `BlockRegistry.getFeaturedBlocks`    | `dbRead.$queryRaw` only                                                                         |
| `BlockRegistry.getMarketplaceMeta`   | `dbRead.appBlock.findUnique`                                                                    |
| `BlockRegistry.setMarketplaceMeta`   | `dbWrite.appBlock.*`                                                                            |
| `upsertAppBlockReview`               | `dbWrite` for `findUnique`/`create`/`update`; `dbRead` for `findMany` and a second `findUnique` |
| `setAppReviewExcluded`               | `dbWrite.appBlockReview.update`                                                                 |
| `bustAppRatingCache`                 | `dbRead.appBlock.findUnique`, `dbRead.blockUserSubscription.findFirst`                          |

**The `:2032` inversion is the trap.** Four sites default to `dbWrite` and one defaults to `dbRead`.
Anyone who learns "the default is write" from the first four and applies it to the fifth gets a
silent mis-route. Check the site, not the pattern.

## Mechanism 2: the client is chosen by REPLICATION LAG, not by a caller

Found later, and it is the more common of the two. `getDbWithoutLag` (`db/db-lag-helpers.ts:46`)
returns `dbRead` or `dbWrite` depending on runtime state:

```ts
if (env.REPLICATION_LAG_DELAY <= 0) return dbRead; // production: ALWAYS taken (default 0)
return (await lagTracker.isStale(lagKey(type, id))) ? dbWrite : dbRead;
```

Anything reached through it — `model-version.service.getVersionById` is the one in this slice —
has no fixed client in the source, so the usual grep resolves to `BOTH`.

🔴 **And under test it does not behave as production does.** `REPLICATION_LAG_DELAY` is a zod
`.default(0)` key that is **absent from `TEST_ENV_DEFAULTS`**, so the canonical env reads it as
`undefined`; `undefined <= 0` is `false` where `0 <= 0` is `true`. **Every test whose path reaches
`getDbWithoutLag` without mocking `db-lag-helpers` takes a staleness branch production never
takes**, and lands on whichever client a redis read decides. 73 zod-defaulted keys exist, 59 are
absent from `TEST_ENV_DEFAULTS`, and 40 of those have numeric or boolean defaults where `undefined`
is not equivalent. Fixing that is a shared-mock change, not a slice change.

**Affected here, and NOT to be split by inspection — TWO files, not the five first claimed:**

| file                               | entry point                         | why                                                                                          |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `model-version.blue-buzz-purchase` | `earlyAccessPurchase` (`:2003`)     | reads through `getVersionById`, which is `forceWriteDb ? dbWrite : await getDbWithoutLag(…)` |
| `model-version.purge-by-hash`      | `publishModelVersionById` (`:1420`) | calls `getDbWithoutLag` directly                                                             |

🔴 **The other three RESOLVE by entry point and are ordinary conversions.** I filed them here on a
whole-module scan, which is the mistake this section is about:

- `model-version.deregister` → `deleteVersionById` (`:1047`) uses **`dbWrite` only**. The `dbRead`
  spellings elsewhere in `model-version.service` belong to functions this test never calls.
- `model-file.service` and `model-file-scan.service` → **neither service mentions
  `getDbWithoutLag` at all.**

**`BOTH` from a whole-module scan is not a verdict, it is an unanswered question.** What resolves it
is the entry point the _test_ imports. A file belongs in this section only when that entry point
itself defers the choice to runtime — a caller's `db` option, or replication lag — never because a
large module happens to contain both spellings.

⚠️ **Why the already-converted files in this slice were safe is a coincidence, not a judgement.**
`contest-entry-base-model-gate`, `contest-entry-resource-gate`, `article-locked-properties`,
`model-locked-properties`, `model-flag-side-effects` and `model-version.linked-component` all mock
`~/server/db/db-lag-helpers` directly, which pins the client before any of this applies. **The safe
and unsafe conversions are separated by whether the test happened to stub that module** — so the
population at risk cannot be read off which files converted cleanly.

## Per file

### `block-registry.pinned-version.test.ts` — 4 cases

Drives `BlockRegistry.resolveBlockInstance` and `BlockRegistry.applyPinnedVersion`, no `db` option →
**`dbWrite`** for `blockUserSubscription.findUnique` and `appBlockPublishRequest.findFirst`.
`model.findUnique` resolves to `dbRead` in the service source directly.

🔴 Negative assertion: `expect(mockDb.appBlockPublishRequest.findFirst).not.toHaveBeenCalled()`
(×2). Routed to `dbRead` it would pass **whatever the code did**, because the code only ever calls
it through the parameterised `db`, which here is `dbWrite`. This is the single most dangerous
assertion in the bucket.

### `block-registry.resolve-instance.test.ts` — 27 cases

All through `resolveBlockInstance`, no `db` option → **`dbWrite`** for
`blockUserSubscription.findUnique` / `.findFirst` and `platformDefaultBlock.*`; `model.findUnique`
and `modelVersion.findFirst` are spelled `dbRead` in the source.

🔴 Negative assertion: `expect(mockDb.blockUserSubscription.findUnique).not.toHaveBeenCalled()` —
must be `mockDbWrite`.

### `block-registry.marketplace-meta.test.ts` — 14 cases

Three entry points with **different** clients: `getFeaturedBlocks` → `dbRead.$queryRaw`,
`getMarketplaceMeta` → `dbRead.appBlock.findUnique`, `setMarketplaceMeta` → `dbWrite.appBlock.*`.
This is the one file where `appBlock.findUnique` genuinely appears on **both** clients, so the split
has to follow the case's entry point rather than the path.

🔴 Negative assertion: `expect(mockDb.appBlock.update).not.toHaveBeenCalled()` (×3) — `update` is
`dbWrite`-only, so this one is safe to route mechanically.

### `block-registry.spend-cap-config.test.ts` — 15 cases

`appBlock.update` → `dbWrite`; `appBlock.findUnique` → follows the entry point as above.
🔴 Same `appBlock.update` negative assertion; same reasoning.

### `appBlockReview.service.test.ts` — 17 cases

`upsertAppBlockReview` uses **both** clients for `appBlockReview.findUnique` — `dbWrite` for the
existence check, `dbRead` for a later read. Splitting by path alone is wrong here; split by which
call the case is asserting.
🔴 Negative assertions on `appBlockReview.update` (×2) and `.create` (×4) — both `dbWrite`-only
inside `upsertAppBlockReview`, so mechanical routing is safe for those six.

### `appBlockReview.collaborator-self-review.test.ts` — 11 cases

`appBlock.findUnique` and `blockUserSubscription.findFirst` → `dbRead` (via `bustAppRatingCache`);
`appBlockReview.create` → `dbWrite`.
🔴 Negative assertion on `appCollaborator.findMany`, which **appears on neither client in the
service source**. I could not resolve it and did not guess — read the case before routing it.

## What I am not certain about

- **`appCollaborator.findMany`** above. It may be reached through another module or another
  parameterised client. Unresolved.
- **Whether any case relies on the two clients being the same object.** The alias made them one, so
  a test could be asserting on a call made through the other client without anyone noticing. The
  `model-appeal` case in this slice was exactly that shape one level down (a transaction client that
  was deliberately separate), and it is invisible in a diff.
- **`resolveBlockInstance`'s 27 cases** are more than I read individually. I resolved the entry
  point and the defaults, not each case's intent.

## How to verify a split here, since a run will not do it alone

1. Route the positive assertions first and run — mis-routing those **is** visible.
2. For each negative assertion, flip it to a positive on the client you believe the code uses and
   confirm it fails when it should. An assertion that cannot be made to fail is not routed, it is
   inert.
3. `residual-mocks.mjs` and collected counts will be clean either way. They detect absence, not
   vacuity — see `docs/testing/shared-module-mock-migration.md`, "What the gate does NOT catch".
