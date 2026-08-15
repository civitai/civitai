# The `dbRead`/`dbWrite` alias split where the service picks its client at runtime

Written by josh, 2026-08-15, for the `src/server/services/__tests__` a–m slice of the shared-mock
migration (branch `perf/test-mock-migration-services-a-m`). This is the one bucket in that slice
where the routing decision is **not** readable off the production source in the usual way, so it is
written up per case rather than handed over as a to-do list.

## The problem

Most files that mock `~/server/db/client` with one local serving both clients —

```ts
vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
```

— can be split by reading the module under test: find `dbRead.model.method` or
`dbWrite.model.method` and bind accordingly. Two things break that here.

**1. `block-registry.service.ts` takes its client as a parameter.** Five call sites do

```ts
const db = opts.db === 'read' ? dbRead : dbWrite;   // :1362, :1819, :1887, :1928
const db = opts?.db === 'write' ? dbWrite : dbRead; // :2032  — note the INVERTED default
```

and pass `db` down (`applyPinnedVersion(live, appBlockId, pinnedVersion, db)`). So a grep for
`dbRead.appBlockPublishRequest.findFirst` finds **nothing**, and the client a given test exercises
is a fact about the *test's* call, not about the service.

**2. Routing an alias wrongly is silent for a negative assertion.** A positive assertion goes red
when the call lands on the other node. `expect(mockDb.appBlockReview.create).not.toHaveBeenCalled()`
passes **trivially** if `create` is routed to the client the code never touches. These six files
carry 14 such assertions, so a wrong guess is not caught by running the suite.

## The resolution, and a correction to my earlier claim

I reported these as needing a per-test decision and possibly permanent hand-work. **Having read
them, that is too pessimistic: every case here is statically determinable, because no test in the
six passes a `db` option at all.** Verified by grepping each file for `db: 'read'` / `db: 'write'` —
zero hits. So each entry point falls to its own default, and those defaults are fixed:

| entry point | client when no `db` option is passed |
|---|---|
| `BlockRegistry.resolveBlockInstance` | **`dbWrite`** (`opts.db === 'read' ? dbRead : dbWrite`) |
| `BlockRegistry.applyPinnedVersion` | inherits the caller's — from `resolveBlockInstance`, **`dbWrite`** |
| `BlockRegistry.getFeaturedBlocks` | `dbRead.$queryRaw` only |
| `BlockRegistry.getMarketplaceMeta` | `dbRead.appBlock.findUnique` |
| `BlockRegistry.setMarketplaceMeta` | `dbWrite.appBlock.*` |
| `upsertAppBlockReview` | `dbWrite` for `findUnique`/`create`/`update`; `dbRead` for `findMany` and a second `findUnique` |
| `setAppReviewExcluded` | `dbWrite.appBlockReview.update` |
| `bustAppRatingCache` | `dbRead.appBlock.findUnique`, `dbRead.blockUserSubscription.findFirst` |

**The `:2032` inversion is the trap.** Four sites default to `dbWrite` and one defaults to `dbRead`.
Anyone who learns "the default is write" from the first four and applies it to the fifth gets a
silent mis-route. Check the site, not the pattern.

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
