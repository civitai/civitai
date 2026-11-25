# app-data-go: the writes service (P3b), design

**Status:** design, decided by the operator on 2026-11-22 (see "Decided"); amended by the generic core
on 2026-11-24 ("Delta: the generic core"), which wins where the two disagree. This follows
the reads in [DESIGN.md](DESIGN.md), which lists "Any write path (P3b)" under "Not built"
(`DESIGN.md:568`). Direction from the operator (2026-11-19): the complete app platform runs via the
registry, and writes go through a registered write service, as a follow-up after reads.

**The overriding principle (operator, 2026-11-22):** the public REST App Storage API
(`/api/v1/blocks/storage`) is to be sunset, leaving the platform registry-only, so nothing may fall
back to it. No part of this design does: not for read-your-writes, not when this service is down,
not for signed-out viewers. app-data-go's existing read fallback to that API (`DESIGN.md:41-44`) is
**transitional** and is removed before REST is turned off ("End state"). The tokens that stay on REST
for now are named, with what ends it ("Who stays on REST").

**Scope of v1 (operator, 2026-11-22):** the first app, model-benchmarking, moves **all** of its
storage at once: its private `kv` collection and its shared `records` collection (`visibility:
shared`, `write: own`, `marks: [vote]`, scope `apps:storage:publish`; its `block.manifest.json`),
reads and writes, signed-in and signed-out. Code citations are to civitai `main` at `1d4f7a0f`; the
app's to its `main` at `65ce42f`.

## Delta: the generic core (2026-11-24)

[`docs/app-storage-generic-core.md`](../../docs/app-storage-generic-core.md) removes marks, counters,
tallies, `write: "none"` and publish from the store, and adds viewer-keyed documents (`keyedBy`,
`@me[/<parent>]`), which are plain shared documents. Where this document and that one disagree, that
one wins. What it makes of migration step 1:

**Obsolete; not built, and what was built goes with the tally ops (generic core, rollout step 5):**

- the app-wide mark sequence, `mark_head`, `doc_tally.mark_seq`, locks (1b) and (1c), `markSeq` in
  answers, the mark head in `meta`, the `minMarkSeq` floor, and the count and held overlays (#10130,
  merged dark, inert);
- `tallies` on level-stream entities, the `level: counters` stream, `viewer.marks`, and the
  per-viewer stream's mark rows;
- vote read-back: `vote` and `unvote` become `PUT` / `DELETE …/records/@me/<recordKey>` on a
  `keyedBy: "parent+viewer"` collection, and a count is a `keyPrefix=<recordKey>:` list; `report`
  leaves storage for the moderation API, which this service does not carry;
- forwarding `PATCH` (`$inc`, `$mark`, `$unmark`), `_publish` and `_unpublish`;
- the step-1 tests about votes: "an acknowledged vote read back", "a vote changes the tally and
  `viewer.marks` for the voter only", "a `kv` read after a vote meets the mark floor", "a vote leaves
  the document's `seq` unchanged".

**What remains, simplified** (one sequence, `seq`; a vote is a write like any other):

| Piece | Where | State |
|---|---|---|
| Write routes, `info`, signature, `504`/`503` semantics | here | built, #10143 |
| `PUT` / `DELETE …/records/@me[/<parent>]` forwarding | here | #10393 |
| Private keyed get, record overlay, floors and the bounded reopen | here | built, #10158 |
| Shared reads: the union of the level streams in the viewer's mask and the per-viewer stream; `@me` gets; `keyPrefix`, `author=me`, key-sorted pages | here | #10393 |
| Signed-out reads from the level streams | here | #10393 |
| No REST fallback (the step-1 table) | here | #10393: with `APP_DATA_WRITES` on, every read |
| Region forwarding on the per-viewer and private subscriptions | here | built, behind `APP_DATA_FORWARD_REGION` (default off): while off, the adapter holds every signed-in viewer behind this service to SFW |
| Second replica, header-hash sticky routing | deployment | not built |
| Internal route, store `seq`/`recordId`, `app_storage_requests_total{via}` | site | built, #10128, #10142 |
| The internal route's delete answer names its key (an `@me` delete's derived key) | site | #10392 |
| `Entity.seq`, `k2`, the private head | adapter | built, #10128 |
| Level streams of plain documents, the shared-level allowlist | adapter | built, dark, #10302, #10343 |
| `meta.truncated` on level streams | adapter | #10392 |
| The per-viewer stream | adapter | #10392 |
| The fifth block-exchange claim | hub | built, #10163, #10192 |

**The per-viewer stream, as simplified.** It carries **every** document of the collection the token's
user authored, at every rating state REST shows its author (not only the ones no level stream gives
them): a document is the viewer's own (`author.isViewer`) when this stream holds its key, and `@me`
is answered from it without the derivation key, which stays the site's. Its `live` and `progress`
`meta` name `{head, mask, levels, keyedBy}`; a `meta` with no `mask` is the explicit refusal (`401
refused`); a resolution failure is an `end` with `reason: not_resolved` (`503`). Cursor `v1.`.

**Session decisions in this delta** (each reversible by flag-off; none overrules "Decided"):

1. The union's overlays are dropped once every stream the read used names a head at or above them,
   not when one does: the level streams poll apart from the per-viewer stream.
2. A shared read never reopens a stream for its floor: the level streams are every viewer's, so a
   reopen per viewer is a full re-read of the board. An unmet floor is `503 floor_not_met`. The
   consequence: a hub-token viewer that sends `minSeq` right after its own write gets `503
   floor_not_met` until every stream the read uses names a head at or above the write, which is up to
   one adapter poll (`REGISTRY_ADAPTER_POLL_SECONDS`, default 60 s); the SDK retries a `503` with
   backoff, so the write reads back late, never wrong. A block token's floor is met sooner, by the
   overlay this replica acknowledged for it (a hub token's write may have landed on another replica).
3. app-data-go evaluates no flag. With `APP_DATA_WRITES` on, every read is a cut-over app's and never
   falls back to REST; the per-app flag `app-data-writes-via-service` decides whether the site hands
   an app this service at all. The shadow's registry-only answer is unchanged.

**Stream and memory budget (#10393).** Every stream this service opens, private, level or
per-viewer, takes one slot and its manager's per-stream byte bound from one budget per replica:

| Setting | Default | Bounds |
|---|---|---|
| `APP_DATA_MAX_SUBSCRIPTIONS` | 100 | adapter subscriptions per replica, all three kinds together (the replica's share of the adapter's caps, `DESIGN.md`, "Stream budget against the adapter's caps") |
| `APP_DATA_CACHE_BUDGET_BYTES` | 224 MiB | the byte bounds the open streams reserve together |
| private: `MAX_STREAMS`, `MAX_BYTES_PER_STREAM`, `MAX_OVERLAY_BYTES_PER_STREAM` | 100, 2 MiB, 128 KiB | a private stream reserves 2 MiB, or 2.125 MiB with the writes on |
| level: `LEVEL_MAX_STREAMS`, `LEVEL_MAX_RECORDS`, `LEVEL_MAX_BYTES` | 10, 3,000, 8 MiB | a level stream reserves 8 MiB |
| per-viewer: `VIEWER_MAX_STREAMS`, `VIEWER_MAX_RECORDS`, `VIEWER_MAX_BYTES` | 40, 20,000, 4 MiB | a per-viewer stream reserves 4 MiB; 20,000 records is the adapter's own per-viewer bound |
| shared overlays (fixed) | 10,000, 16 MiB | apart from the budget; only writes to a collection whose level stream reached `Live` |

The arithmetic, against the deployment's `GOMEMLIMIT` of 400 MiB under a 512 Mi limit: the budget
plus the shared overlays is 224 + 16 = 240 MiB of cache, 60%, leaving 160 MiB to the runtime, each
record's overhead past its counted bytes, and in-flight requests. The budget holds the private manager
alone as before (100 × 2 MiB = 200 MiB with the writes off, 100 × 2.125 MiB = 212.5 MiB on), or, for
example, 10 level streams (80 MiB), 20 per-viewer (80 MiB) and 30 private (63.75 MiB). A read whose
stream would pass either the slot count or the bytes opens nothing: `capacity`, `503` on the shared
path. This replaces the per-cutover sum in "Size, count and alert": the budget bounds the whole
process, whatever the mix of apps. A read of the level streams the registry refuses `invalid_token`
is this service's own token refused: `503 service_token_refused`, and the token is re-minted.
A signed-out read of a collection major not yet seen to resolve on the replica opens one level stream
first (at most 2 such probes per app at once, then `503 capacity`), so a made-up collection or major
costs one stream, which the adapter ends `not_resolved`.

## What is fixed before we start

1. **The registry protocol has no write.** It has one call, `Subscribe`, and only an entity's
   origin changes it (civitai-registry `spec/registry.md:3`, `:50-51`). Its design article puts writes
   at the source: "An entity never changes through a registry" (`docs/articles/design.md:311`). So
   "writes through the registry" means a write **service discovered through the registry**, never a
   write carried by one.
2. **The App Storage document store is the one writer.** Every document write is one transaction in
   `doc-store.ts` (`src/server/services/apps/doc-store.ts:2211-2294`): lock the row, write, sync the
   index rows, charge `usage_app` (which hands out the next `seq`), charge `usage_user`, stamp the
   `seq`. `usage_app` is keyed per (app, namespace) (`SQL_CHARGE_APP`, `doc-store.ts:893-900`), so
   the `seq` is one counter for every collection of the app, private and shared, in commit order
   (`doc-store.ts:104-106`). The lock order is (1) the document row, (1b) its tally and mark rows,
   (2) `usage_app`, (3) the caller's `usage_user`; marking takes only a `KEY SHARE` lock on the
   document and the tally row, and no usage lock (`doc-store.ts:97-102`, `SQL_SHARE_LOCK_DOC`
   `:942-949`).
3. **The `seq` is also a revision others depend on.** Moderation's hide and unhide check it as the
   document's revision (`assertModRevision`, `doc-store.ts:4298-4305`), and the rater applies a
   rating only to the `seq` it rated (`doc-store.ts:4718-4720`). A change that moves a document's
   `seq` without changing its content would make both refuse work that is still valid.
4. **The registry adapter learns about writes only by polling the store.** No outbox, trigger or
   `NOTIFY`. The private feed re-reads one user's keyset of `(key, version, record_id)` and diffs it
   (`doc-store.ts:1033-1045`); the shared feed reads `doc` and `doc_tomb` rows by `seq` range
   (`doc-store.ts:976-1026`). Both run every `REGISTRY_ADAPTER_POLL_SECONDS`, default 60 s
   (`src/server/registry-adapter/main.ts:144`).
5. **The write path's gates.** The route is `withBlockScope(withAxiom(createStorageHandler()))`
   (`src/pages/api/v1/blocks/storage/[[...path]].ts:29-36`). `withBlockScope`
   (`src/server/middleware/block-scope.middleware.ts:1593`) verifies the block JWT, its revocation and
   its consent, strips unconsented scopes, enforces `requiredScope: 'apps:storage'`, and sets
   `req.blockClaims`. The handler then runs, in this order (`src/server/services/apps/doc-store-api.ts:1215-1300`):
   a signed-in viewer, the collection's write policy, the publish scope for a shared create or put,
   the body parse, the collection schema, owned model versions; then, for a private write or any
   delete, the `write` rate bucket (`doc-store-api.ts:1297-1299`), or, for a shared create or put, the
   trust gate (`assertTrusted`, `:884`) and the shared-write budget (`reserveSharedWrite`, defined at
   `src/server/utils/shared-storage-rate-limit.ts:366`, called at `doc-store-api.ts:1111`); then the
   permission hook (`gateHook`), the moderation scan for a shared write (`moderate`, `:978`), and the
   store, which for a shared write with content levels on marks the document pending
   (`SQL_RATING_PENDING`, `doc-store.ts:855`). A delete of a published shared item syncs its App Store
   card (`syncStoreItem`, `doc-store-api.ts:1288`).
6. **The hub has no app-data write scope.** `AppDataRead` is bit 32
   (`packages/civitai-auth/src/token-scope.ts:115`); the block exchange issues exactly that
   (`apps/auth/src/lib/server/oauth/block-exchange.ts:97`).

## What the app does with its storage

| App call | Store op | Collection |
|---|---|---|
| `kv.get` (`src/lib/kv-store.ts:120-126`; used at `src/App.tsx:1003`, `:1306`, `:2577`) | get by key | `kv` (private) |
| `kv.set` (`kv-store.ts:127-130`) | **unconditional** put | `kv` |
| `kv.delete`, `kv.list({prefix, limit, cursor})` (`kv-store.ts:131-150`) | delete; list by `keyPrefix`, paged | `kv` |
| `getQuota` (`kv-store.ts:151-159`) | `info`: the viewer's usage and limits | the store |
| `append` (`src/lib/records-store.ts:240-246`) | create, server-minted ULID key (`:51-57`) | `records` (shared) |
| `update` (`records-store.ts:248-262`) | get, then put with `ifVersion: current.version` | `records` |
| `withdraw` (`:265-267`) | delete | `records` |
| `vote` / `unvote` (`:269-273`) | `$mark` / `$unmark` `vote`, answering the new count | `records` |
| `report` (`:275-277`) | `$mark` `report` (built-in, never withdrawn, its count never exposed) | `records` |
| `list` (`:224-236`; `src/App.tsx:4285`) | list, `sort: -key`, `limit` ≤ 100, `cursor` | `records` |

Each `records` item it reads uses `key`, `data`, `version`, `updatedAt`, `marks.vote` and
`viewer.marks`, and the author only as "the reader wrote this" (`records-store.ts:24-26`, `:72-78`).
It does not call `_publish`, `_unpublish` or counters.

## The write path

```
app ──► app-data-go (public)  ──►  the site's INTERNAL storage route  ──►  doc-store.ts
                                       (not reachable by apps)              (the one writer)
```

**The API.** Every write the public storage route has, plus `info`, under this service's path, with
the same bodies, so an SDK swaps the base URL and nothing else:

```
POST   /v1/apps/{slug}/collections/{c}/records                 {data}              create (append)
PUT    /v1/apps/{slug}/collections/{c}/records/{key}           {data, ifVersion?}  put (update)
DELETE /v1/apps/{slug}/collections/{c}/records/{key}[?ifVersion=N]                 delete (withdraw)
PATCH  /v1/apps/{slug}/collections/{c}/records/{key}           one of {$inc}, {$mark}, {$unmark}
POST   /v1/apps/{slug}/publish/{to}                            {from, keys, prune?}
POST   /v1/apps/{slug}/unpublish/{to}                          {keys}
GET    /v1/apps/{slug}/info                                    the viewer's usage and limits
Authorization: Bearer <the app's token for the user>
→ the store's answer, status and error code as the store produced them, plus `seq` (see below)
```

`info` is forwarded, not served from a stream: usage and limits are the store's accounting
(`usage_user`, the viewer's tier ceilings) and no stream carries them. It goes through the same signed
internal route, which is the store's own front door, not the public REST API.

Concurrency is the store's: an integer `ifVersion` (`0` = must not exist), `409 version_conflict`
with `currentVersion` (`doc-store.ts:2221-2237`); 64 KiB documents; the grammars of
`doc-store.types.ts:151-170`. Tallies do not change a document's `version`. A request naming a schema
major other than the collection's current one is `409 stale_major` (with `details.currentMajor`);
none named means current. The site decides it: this service forwards a named `major` as a query
parameter (shape-checked only) and relays the answer, and the site validates it against the
collection's current major (`resolveSchemaMajor`, `doc-store-schema-major.ts`) and answers
`409 stale_major`, the same major it stamps on every write (`withSchemaMajor`,
`doc-store-api.ts:825-833`). No copy of the current major is kept here, so none can be stale.
**Imports are not v1** (below).

**The internal route.** The public route's path under an `internal` prefix, on the site, running
**the same middleware chain as the public route**, `withBlockScope(withAxiom(createStorageHandler()))`
with the same options (`requiredScope: 'apps:storage'`), for the write verbs and `info` only. In order:

1. **Signature, before anything else.** The route lives on the same public-facing site processes as
   every other route, so a network policy cannot single it out; this signature is what keeps apps off
   it, and what makes the `via` count trustworthy. The request carries `x-app-data-ts` (unix seconds)
   and `x-app-data-sig` = hex HMAC-SHA256, with a key (at least 32 bytes) only this service and the
   site hold, over these six lines joined by `\n`: the method; the request path exactly as sent (no
   decoding or normalisation); the full raw query string (empty when there is none); the timestamp;
   the hex SHA-256 of the raw body, which for an empty body is the SHA-256 of zero bytes
   (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`); and the forwarded region:
   the values of `cf-ipcountry`, `cf-region-code` and `x-isuk` (the headers the site's `getRegion`
   reads), in that order, joined by `,`, each empty when absent, the whole line empty when all three
   are. This service copies those headers from the viewer's request (each `[A-Za-z0-9-]{1,16}`, sent
   once, else it refuses the write `400`), so the site can apply the region decision to values the
   signature covers. A timestamp more than 60 s from the site's clock, a malformed region header, or
   a mismatch is a `401 service_signature` and nothing else runs; with no key configured the route
   answers `404 service_route_off`. This service maps both to `503 not_forwarded` (they refuse before
   anything runs), never to the viewer's own `401` or `404`. The golden vectors are one file both
   sides' tests read (`internal/sign/testdata/vectors.json`).
2. **The body, buffered once.** The route disables Next's body parser as the public one does
   (`[[...path]].ts:23`), reads the raw body itself up to `STORAGE_BODY_LIMIT_BYTES`
   (`doc-store-api.ts:483`; over it a `413` in the storage envelope), hashes it for the signature, and
   hands the same bytes to the handler as the request stream, so `readJsonBody` (`:489`) reads what was
   signed.
3. **The path the chain sees is the public one.** After the signature is checked, the route sets
   `req.url` to the public route's path and query, so the handler's routing and `withBlockScope`'s
   audit row see the same request: the audit row's endpoint column is `normalizeEndpoint(req.url)`
   (`block-scope.middleware.ts:2234`, `:2447`), so a forwarded call reads as the same endpoint as a
   direct one, and the route also passes the public route's `endpoint` label. The `via` is the
   counter's, not the endpoint's.
4. **`withBlockScope`, unchanged.** The signature authenticates the **caller** (this service) only and
   confers no user or app authority: that is still the user's token, verified by `withBlockScope` and
   judged by the handler (`resolveStorageAccess`, `doc-store-access.ts:141-215`) exactly as on the
   public route. The route must never set `req.blockClaims` itself; only `withBlockScope`, after
   verifying the token, does.
5. **The target app.** This service forwards `from=<slug>` on every call. The handler treats a `from`
   naming the token's own app as an own call, identical to omitting it (`otherAppSource`,
   `doc-store-api.ts:1600-1611`), so the slug can never name an app the token is not for without
   becoming an import. **The internal route refuses every import** (`otherAppSource` not null) with
   `501 not_supported_here`. The site must do this, not this service: only the site resolves which app
   the token was issued for, and this service never decodes a token.
6. **Its answer adds what the overlay needs:** a create or put returns the record's `seq`,
   `recordId`, `createdAt` and `updatedAt`; a delete returns its tombstone's `seq`; a mark or unmark
   returns `{marked, count}` (as today) plus the mark's own sequence, `markSeq`; a publish or unpublish
   returns each changed key's `seq` ("Store changes").

A test lists the `withBlockScope(… createStorageHandler …)` entries (the public route, this one) and
fails if the set grows or shrinks.

**Retries.** This service never retries a forward. A forward whose answer is lost answers
`504 {outcome: "unknown"}`, and **a read cannot prove the write did not happen**: it may commit after
the read, and a create with a server-minted key cannot even be looked for. The only safe retry is a
keyed `put` with `ifVersion` (`0` for a create, the version last read for an update), which the store
refuses with `409 version_conflict` if the first attempt landed. A mark or unmark is idempotent and
safe to resend. A server-minted create (the app's `append`) has no safe retry: the SDK surfaces the
unknown outcome. The guidance is to mint the key in the app and `put` with `ifVersion: 0`, which a
`write: own` collection accepts (`records-store.ts:251`); an app-minted key must be a ULID, so the
board's `-key` order stays creation order (`records-store.ts:51-57`).

## Source of truth and consistency

**Single writer.** Every write commits through `doc-store.ts`; this service holds no data but its
stream caches. There is no dual-write: the registry is not a store (fixed point 1). A client sees the
store's model: a write is acknowledged after commit; writes to one key are ordered by `version` and
refused by `ifVersion`. Rollback needs no data movement, because nothing was written anywhere else.

## The read path

### Private collections (`kv`)

Unchanged from DESIGN.md: one stream per token on the private feed. A list (`keyPrefix`, `limit`,
`cursor`) and a **keyed get** are answered from that stream's cache (base plus overlay, below), under
the same floor rule. The app's `kv.get` calls are therefore stream reads, never a REST get.

### Shared collections (`records`): why the existing feeds cannot serve them

- The shared document feed (`src/server/registry-adapter/doc-feed.ts`) streams a collection only when
  its app is listed and approved and its manifest opts it into the registry (`registry: "public"`,
  `doc-streams.ts:1-4`, `:30-36`). `records` does not, so it has no stream.
- An exported collection's stream is per collection major and audience, narrowed by the app's rating
  and, with levels on, each document's level at `audienceDocLevel(audience)`
  (`doc-feed.ts:34-40`, `:103-107`; `src/server/services/apps/doc-levels.ts:83-91`). It carries the
  body only (`FeedDocument`, `doc-feed.ts:53-58`): no tallies, no viewer marks, no author, no
  `version` timestamps, and never a `seq` (`:9-11`, `:30-32`).
- A mark changes neither the document's `version` nor its `seq` (`doc-store.ts:2565-2625`), so no
  stream would carry a vote.
- The REST list is per viewer (`sharedDocLevelVisible`, `doc-store.ts:771-777`): others' documents
  at the viewer's level, the viewer's own unrated documents, each item's tallies (report counts
  excluded, `doc-store.ts:1470-1480`), the viewer's own marks, and whether the viewer wrote it.

### The shape: one stream per level bit, one small stream per viewer

One stream per viewer holding the whole board does not scale: a stream's bounds are 1,000 records and
2 MiB (`DESIGN.md:336-337`) while a shared collection may hold up to 50 MiB and 1M documents
(`doc-store.types.ts:144-149`), every viewer would hold one per shared collection on top of their
private ones, and `MAX_STREAMS` bounds a replica. So the board is split by who it differs for:

- **A level stream per (collection major, level bit)**, read by app-data-go under its own service
  identity and shared by every viewer. A rated shared document has exactly one level bit (a document
  is within a viewer level when its one bit is in the set, `doc-levels.ts:17-18`), so the five
  selectable bits (PG, PG-13, R, X, XXX) **partition** the visible board: each document is in exactly
  one level stream. Each entity carries `key`, `data`, `version`, `createdAt`, `updatedAt`, `tallies`
  (counters and mark counts, report excluded) and `seq`; deletes, moderator hides (tombstones,
  `doc-store.ts:4489-4493`) and re-ratings to another bit arrive as `Delete`s (and an `Upsert` on the
  new bit's stream). It never carries an author, a viewer's marks, or an unrated document.
- **With content levels off for the app** (the flag `app-blocks-shared-doc-levels`, read per app;
  an unreadable flag counts as on, `doc-levels.ts:38-41`), the feed's `docLevels` switch leaves the
  level gate out (`doc-feed.ts:103-108`), and there is **one** stream of every visible document: the
  subscription that names `level: none` in `meta`. **The adapter is authoritative for the mode:** every
  level stream names it (`levels: on|off`) in its `Live` and `Progress` `meta`. The adapter refuses a
  `level: none` subscription before any snapshot while levels are on (an unreadable flag included),
  ends one with reason `levels_on` when they turn on, and ends the per-bit streams when they turn off.
  app-data-go serves the single stream only while its own latest `meta` says `levels: off`; on a
  `levels_on` end it fails closed to the per-bit shape, and on any other end it reopens `level: none`.
  During a switch, reads wait `LIVE_WAIT_MS` and then answer `503 not_live`. The off-to-on window (up to
  one poll) is the public document feed's today, which also reads the mode per poll
  (`doc-feed.ts:324`, `:347-351`).
- **A per-viewer stream per (token, collection major)**, read under the viewer's exchanged token like
  the private streams. It carries only what differs for that viewer: their marks on the collection's
  documents, the keys they authored, and their own documents no level stream gives them (unrated,
  pending, or rated outside their level but inside their own domain ceiling, `sharedDocLevelVisible`'s
  author arm, `doc-store.ts:771-777`). Its `Live` names the viewer's **level mask**, decided by the
  adapter.

A read is answered by the **union** of the level streams whose bits are in the viewer's mask, plus the
viewer's own extra documents, ordered by key and **deduplicated by key, keeping the higher `seq`** (a
re-rating moves a document between bits, and the two streams may briefly both hold it). Counter
documents (`author_kind = 'counter'`, visible at every level, `doc-store.ts:773`) are carried on one
designated stream of their own, which every viewer reads (routed like a level stream under a
`level: counters` name, sized with them, and served to signed-out viewers too; v1's app declares no
counters, so it is empty), with `viewer.marks` and
`author.isViewer` filled from the per-viewer stream. Signed-out viewers use the level streams alone
("Signed-out viewers").

**The level mask.** For others' documents REST uses the token's viewer level,
`resolveViewerBrowsingLevel(maxBrowsingLevel, viewerBrowsingLevel)`
(`src/server/services/blocks/block-viewer-ceiling.ts:20-29`, via `viewerDocLevel`, `doc-levels.ts:60-64`).
The registry today has only the audience and, for an exchanged block token, the ceiling
(`civitai_max_browsing_level`; the four binding claims, `blockBindingOf`,
`src/server/registry-adapter/auth.jwt.ts:121-156`). Masked at
`audienceDocLevel(audience) & onlySelectableLevels(maxBrowsingLevel)`, **PG-13 is always admitted**
(`audienceDocLevel` sets PG and PG13 for everyone, `doc-levels.ts:83-91`), unlike REST, which leaves
it out for a viewer whose level does. **Chosen: add the viewer's level to the exchange** as a fifth
claim, `civitai_viewer_browsing_level`; the mask is then exactly `resolveViewerBrowsingLevel` of the
two claims, REST's own level. The deploy order, so no release refuses a token another still mints:

1. the hub writes `civitai_viewer_browsing_level` on every block-exchange token;
2. the adapter accepts both a four-claim token (interim mask: the audience-and-ceiling mask above) and
   a five-claim token (exact mask). `blockBindingOf`'s all-or-nothing rule then covers the four
   binding claims, and the fifth is checked on its own: absent means the interim mask, present and not
   a non-negative integer means `invalid`;
3. once no four-claim token can still be live (the exchanged token's 15-minute cap after step 1 is
   everywhere), the adapter requires all five.

Until step 3, the one divergence (PG-13 shown to a viewer who turned it off) is recorded here.

**Region.** The adapter holds a subscription whose region it cannot tell to SFW content, and judges a
relay by the relay's own request (`audience.ts:36-42`; `request-origin.ts`). app-data-go would send
no region, so every viewer behind it would be held to SFW, and an R- or X-rated app's private feed
would refuse every user (its predicate admits the app's rating against the held audience,
`private-feed.ts:312-322`). **Chosen: forward the edge's region.** app-data-go copies the region
values the edge set on the viewer's request (the edge sets them and strips any a client sent; this
service never reads a client's) onto the subscription it opens for that viewer, as the adapter's
region headers. **Precondition:** app-data-go is reachable only through the edge, which strips
client-sent region headers; otherwise region forwarding is off and the SFW hold applies. A viewer's
streams are keyed by token and region, so a viewer whose region changes opens new ones. The exact mask is
ANDed with the region hold. Level streams are read as a service, which has no region; the region hold reaches a
viewer through the mask the per-viewer stream names.

**Authorization stays the origin's.** The level streams hold content only; the per-viewer stream is
the gate. A signed-in viewer is served level streams only while their per-viewer stream is open and
its latest `Live` or `Progress` named a mask. **A refusal is explicit:** when the adapter stops
admitting the viewer (a revoked install, a withdrawn grant, a refused predicate), the per-viewer stream
sends a `Live` (at stream open) or a `Progress` whose `meta` names no mask; both mean `401 refused`.
It never just goes quiet or sends `Delete`s only. This is an adapter change: the private feed today answers a refusal with `nothing()`, deletes on
the next poll and keeps the stream open (`private-feed.ts:303-310`, `:404-420`), so a level-stream read would
otherwise outlive a revoked install by up to the exchanged token's 15 minutes. On that signal
app-data-go drops the viewer from every level stream at once and answers their reads `401 refused`,
as REST refuses them; a later `Progress` naming a mask re-admits them on the same token. Anything else
is not a refusal: a stream that **ends**, and a resolution failure (a schema that does not resolve, an
app or collection that no longer matches, `private-feed.ts:306-307`, `:333-334`), which the adapter
sends as an end with reason `not_resolved`, stop serving and answer `503` while the stream is reopened,
so a catalog lag never reads as `401`. app-data-go never decides a signed-in viewer's level itself.

**Feed routing.** The adapter routes by schema and token:

- a subscription by a client on its shared-level allowlist (a short list, as the registry owner asked
  on civitai-registry#49), naming a level bit in `meta`, to a shared collection's documents URN: that
  level stream, for any shared collection, exported or not;
- a listed relay's user token to the per-viewer URN of a shared collection
  (`urn:schema:apps.civitai.com:<slug>/<c>.viewer@v<N>`): the per-viewer stream;
- anything else, including a token-bearing listed relay subscribing to an **exported** collection's
  documents URN: the public document feed, per audience, exactly as today. app-data-go never uses it.

**Bindings.** A per-viewer stream's stored state binds the subject, the audience, the ceiling, the
viewer level and the region (the private feed binds only schema, subject and audience today,
`private-feed.ts:238`); a cursor resumed under a different binding is refused as expired and the
stream re-snapshots. A level stream's state binds its bit.

**Poll shapes and cost.**

| Stream | Poll | Cost per poll |
|---|---|---|
| Level | `seq` range on `doc` and `doc_tomb` (the shared feed's shape, `doc-store.ts:976-1026`), plus a mark-sequence range on the collection's tally rows | proportional to the changes since the last poll |
| Per-viewer | keyset diff of the viewer's mark rows, authored keys and own extra documents for the collection (the private feed's shape) | proportional to that viewer's own rows, usually a few |

**Size, count and alert.** The level streams partition the board, so together they hold it once.
Before cutover, the board's size in records and bytes, read from the store, per level bit and in
total, must fit the level-stream bound with headroom, and the per-viewer streams' count per replica must
fit `MAX_STREAMS` with the private streams beside them, and the sum over every cut-over app of (the
level-stream byte bound × the streams per major × the collection's majors), plus (`MAX_STREAMS` × the
raised private byte bound), each doubled for the old and new stream held during a reopen, fits the pod's
memory limit with headroom. An alert fires when any level stream passes 75%
of its bound, or the open-stream gauge passes 75% of `MAX_STREAMS`.

**The bound is at least the app's own read.** The app reads at most 2,000 board rows (100 per page, 20
pages, `src/App.tsx:415-420`), and decides "truncated" only by running out of pages with a cursor left
(`:4276-4300`); its store layer drops any server-side flag (`src/lib/records-store.ts:233-239`). So the
level-stream bound is set **strictly above 2,000 records** per stream (and the measured bytes), so a
truncated stream always holds the app's last page and a next cursor past it. A board past the bound
keeps each level stream's newest documents by key up to the bound, and a delete or re-rating inside the
window backfills the next-newest document from beyond it; since the app's own
read is the newest 2,000 of the union, and the newest 2,000 of a union lie within the newest 2,000 of
each part, the app's list answers are unchanged. A keyed `get` of a document outside the window, and so
an `update` of one (a `get` then a `put`, `records-store.ts:248-262`), answers `503 too_large`. There is
no fallback to read it elsewhere; the fix is raising the bound.

### Signed-out viewers

**Decided by the operator:** app-data-go reads the level streams under its own service identity, as an
anonymous viewer, and serves signed-out viewers from them. Registry-only.

- **How app-data-go authenticates to the adapter:** a hub service token for its own service client
  (`APP_DATA_SERVICE_CLIENT_ID`, a client separate from the relay client: the hub mints a service
  token only for a client whose grants are exactly the service grant, and refuses a client that is
  both a relay and a service; client credentials, `AppsRead`), accepted because the adapter's service-client list names it, as
  the app index's is (`auth.jwt.ts:15-25`, `:197-212`; `REGISTRY_ADAPTER_SERVICE_CLIENTS`,
  `auth.live.ts:47-57`), and on the shared-level allowlist above. A service subscription otherwise
  reads every rating (`SERVICE_AUDIENCE`, `audience.ts`), so it names one level bit and the adapter
  serves exactly that bit.
- **Which token is served:** a signed-out viewer's block holds a block token whose subject is the
  anonymous one (`sub: 'anon'`, `src/server/services/block-token-subject.ts:56`). The SDK sends it as
  for any read. app-data-go verifies it locally as it verifies every block token
  (`apps/app-data-go/internal/exchange/blockverify.go`), where today an anonymous subject is refused
  (`:178-180`). The anonymous branch keeps **every other check**: signature, issuer, audience, expiry,
  claim shapes, the 15-minute age cap, and the dev, review and private-run markers (`:181-189`), each a
  refusal. It then requires that the path's slug is the token's `blockId` (the slug the token was
  minted for; `appId` is the OAuth client's id, `block-scope.middleware.ts:83-90`), and that the
  token's `appBlockId` is the slug's approved production block, which each level stream's `Live` names
  (`meta`, from the adapter's own resolution). No install revocation is checked on this path: a
signed-out view is the public view, and the approved-block check covers an unpublished or switched
block. It is **never sent to the hub**: there is no user to
  exchange for.
- **What a signed-out viewer gets:** the level bits in `resolveViewerBrowsingLevel` of that token's own
  claims, which is the public levels within the host's ceiling. It is never wider than the request's
  host: a red-capable host's ceiling cannot widen an anonymous level, and the main (SFW) host's narrows
  it. No marks, no authorship: `viewer.marks` is empty and `author.isViewer` false, as on REST.
- **Writes** stay impossible for a signed-out viewer, as on REST (`requireViewer`).

The level formula is the site's, ported to Go and pinned by golden vectors, as `internal/urn` is.

## Read-your-writes: two sequences, base and overlay

The adapter can lag a write by up to one poll. So this service applies each acknowledged write to the
writing token's caches at once.

**Why `rev` and `version` cannot order writes.** A private entity's `rev` is a digest (`privateRev`,
`private-feed.ts:184-192`); `doc.version` restarts at 1 when a key is re-created (`SQL_INSERT_DOC`,
`SQL_DELETE_DOC`, around `doc-store.ts:834-862`), and a re-created key is a new row with a new
`record_id` and URN. **Documents are ordered by `doc.seq`, per key.**

**Marks get their own sequence, and leave `doc.seq` alone.** Giving a mark a `doc.seq` would take
`usage_app` (lock 2) inside a transaction that today takes none, and would move the revision that
moderation and the rater check (fixed point 3), so a vote would make a moderator's hide or a rating
fail as "changed". Instead:

- a **mark sequence** per (app, namespace), exactly like `seq`: one counter row per app namespace in a
  new table, taken by `mark`, `unmark` and `increment` after the document's lock and the tally row
  (lock (1c)), and stamped on the tally row and the viewer's mark row it changed. It is shared by every
  collection of the app, so every stream's mark head advances with every tally write of the app, and a
  collection with no marks (such as `kv`) still has a mark head to meet a floor against;
- **the lock order** becomes (1) the document row, (1b) its tally and mark rows, (1c) the app's
  mark-sequence row, (2) `usage_app`, (3) the caller's `usage_user`. A mark or unmark, and an increment
  of an existing document, take (1) `KEY SHARE`, (1b), (1c) and nothing after. An increment that
  creates its counter document takes (1), (1b), (1c), then (2) and (3) for the create's accounting
  (`doc-store.ts:2530-2552`), so it holds (1c) while it waits on `usage_app`. A document write takes
  (1), (1b) where it has tallies, (2), (3), and never (1c). Every transaction takes them in that order,
  so no cycle can form. The cost: one (1c) row per app serializes every vote of the app;
- `doc.seq`, moderation's revision and the rater's binding are untouched.

**The heads.** Every stream, private, level and per-viewer, carries two heads on `Live` and on each
change batch's `Progress` (in `meta`): the document head, `usage_app.last_seq` (`SQL_FEED_HEAD`,
`doc-store.ts:981`), and the mark head, both per app namespace. A head says every write of that kind
at or below it is in what the poll read. Each poll reads its heads in the same transaction as its
rows, or before them, never after. **Accepted:** the heads, and a write's `seq` or `markSeq`, tell their
holder the app's whole write and mark volume between two reads, every user's included; the mark head
counts `report` marks too, so it discloses report volume, which the tallies themselves never expose
(`doc-store.ts:1470-1480`).

**Store changes.** `DocRecord` (`doc-store.types.ts:90-103`) has no `seq` or `recordId`, `docColumns`
(`doc-store.ts:691-700`) selects neither, and `delete` returns only `{deleted}` (`doc-store.ts:2440-2480`).
So: `create` and `put` return `seq` and `recordId` (the row's `record_id`); `delete` returns `{deleted: true, seq}`
(`{deleted: false}` has no `seq`, wrote no tombstone, and the cache applies nothing); `mark`, `unmark`
and `increment` take and return the mark sequence (an increment that creates its counter document
returns its `seq` as well); `publishCopies` and `unpublishCopies` return each
key's `seq` (they already number them, `SQL_CHARGE_APP_SEQS`, `doc-store.ts:1434-1446`). The public
route's `presentDocs` exposes none of these.

**Adapter changes.** The private feed's queries select `d.seq` (`doc-store.ts:1033-1045`) and each
entity carries it (`Entity.seq`, HTTP binding only, as `key` is); `PRIVATE_BODY_FORMAT` goes from `k1`
to `k2` (`private-feed.ts:176-182`), so a resumed cursor re-sends every record with its `seq`; the
level and per-viewer streams carry their sequences from the start; every stream carries both heads.

**The caches: a base and overlays, never merged.** The **base** is what the streams last said. The
**overlays** are what this token's acknowledged writes said since:

- a **record overlay** per key: the record a create or put answered (with `version`, `createdAt`,
  `updatedAt`, `seq`), or a **delete marker** at the tombstone's `seq`;
- a **count overlay** per (key, counted mark or counter): the `count` a mark, unmark or increment
  answered, at its `markSeq` M, dropped once the mark head of the stream carrying that document is
  ≥ M. Heads are app-wide, so for the viewer's own pending document that is the per-viewer stream,
  whose poll also reads the mark-sequence range for its own extra documents (a keyset diff by
  `version` would not see their tallies);
- a **held overlay** per (key, mark): whether the viewer holds the mark, at M. It comes from the
  per-viewer stream, so it is dropped once that stream's mark head is ≥ M. A `report` mark sets only a
  held overlay (`report` in `viewer.marks`); its count is never exposed.

A read answers each overlay where one exists, else the base. Dropping an overlay shows the base
again, never a vanished record.

| Event | Effect |
|---|---|
| Acknowledged create or put at `seq` S | record overlay := the answer, only if S ≥ the overlay's and the base's `seq` |
| Acknowledged delete at `seq` S | record overlay := delete marker at S, same rule |
| `deleted: false` | nothing |
| Acknowledged mark, unmark or increment at `markSeq` M | count overlay := the count (not for `report`), held overlay := held or not, each only if M ≥ its own current `markSeq` |
| Stream upsert of a record at `seq` T | replaces the base; drops the record overlay once T ≥ its `seq` |
| Stream upsert with no `seq` (an adapter before `k2`) | replaces the base only; never drops or outranks an overlay |
| The carrying stream's mark head reaches ≥ M | drops count overlays at or below it |
| The per-viewer stream's mark head reaches ≥ M | drops held overlays at or below it |
| Stream `Delete` of a URN | removes the base for that URN, and drops a record overlay or delete marker for that URN (a moderator hide after the write is a `Delete`, and wins). A `Delete` of another URN, the old row of a re-created key, is ignored |
| An overlay its stream has not caught up with | dropped one poll interval plus 30 s after it was set, showing the base |

The last row bounds the case the stream cannot correct: a private-feed refusal arrives as a `Delete` for
every record the stream held (`DESIGN.md:229-230`), and a record written since the last poll was never
held. Overlays are per token: another viewer of `records` sees a write only when the store shows it to
their level and their streams say so.

**Several replicas.** v1 runs two replicas with a disruption budget. A write acknowledged by replica A
is in A's caches only; a read of the same token on replica B sees it only after B's next poll.
Answer: **no, not without routing**. The fix:

- **Sticky routing by token:** consistent hashing on a digest of the `Authorization` header, which
  needs a proxy in front of the replicas that hashes on a request header; a plain round-robin service
  address cannot do it. Two replicas can each hold streams for the same user while routing moves; that
  extra adapter stream budget is accepted;
- **a block token is served by one replica only.** A block token can be exchanged once
  (`DESIGN.md:169-184`), so only the replica that exchanged it can open its streams; elsewhere its reads
  answer `401 block_token_spent` and the SDK gets a fresh block token. **A write needs no exchange**: the
  site verifies the user's token itself, so a hub outage fails reads, not writes. A block token's writes
  follow the same sticky route as its reads;
- **floors on reads, for when routing moves.** Each acknowledgement carries its `seq` or `markSeq`;
  the SDK sends the highest of each it has been acknowledged for the app (`?minSeq=S&minMarkSeq=M`), both
  app-wide like the heads they are compared with. **Only acknowledgements raise a floor; reads never
  do.** A floor is met when:
  - for a **block token**: max(the stream's head, the highest sequence of an acknowledgement this
    replica made **for this token** whose overlay it still holds) ≥ the floor. Its reads are served only
    here, so its writes normally are too. The residual: if routing moves away and back within one poll
    and a write lands on the other replica, a read here can miss that write until this replica's next
    poll or that write's overlay expiry there (one poll plus 30 s); accepted;
  - for a **hub token**: the stream's head alone ≥ the floor. A hub token is exchanged again on any
    replica, so its writes can land on several, and a write another replica acknowledged at a lower
    sequence could be missing here. The cost: a hub token's write-read-write-read inside one poll spends
    the reopen (for a shared collection, a full re-snapshot of its level streams) and answers `503`.
    Accepted: model-benchmarking reads with block tokens.

  A union read compares each floor against the lowest head among the streams it reads (the level
  streams in the mask, the counter stream and the per-viewer stream).

  When a floor is not met, the replica reopens the stream (a new snapshot, with fresh heads), at most
  once per (token, collection) per poll interval, within `LIVE_WAIT_MS`. If the reopened stream still
  does not meet it, or a reopen was already spent in this interval, it answers `503` with
  `Retry-After` and does not reopen again. A floor covers acknowledged writes only: a write still in
  flight when a read starts may or may not be in that read's answer, as on REST.

**A restart.** Caches are in memory and are lost. The first read opens new streams, whose first `Live`
is a snapshot read from the store at that moment (`DESIGN.md:30-36`), holding every committed write and
carrying heads that meet any earlier floor. A block token whose one exchange was spent on the dead
replica cannot open a stream: the read answers `401 block_token_spent`, and the SDK gets a fresh block
token from its host and retries once.

**The contract a client may rely on:** a write acknowledged by this service is in the store; a read
through this service on the same token afterwards returns it (with the floors, also after routing
moved); any other token, or another viewer, sees it within one adapter poll of the store showing it to
them.

## The empty stream (accepted for v1)

A stream that holds nothing is answered as an empty collection. The private feed answers `nothing()`,
an empty snapshot and `Live`, for: a schema that does not resolve (for example while the catalog lags
an approval), a revoked install, a refusal by the collection-read predicate for any reason but an
unreadable run gate, and an app or collection that no longer matches (`private-feed.ts:304-334`).
Writes still succeed in every one of those cases, because the site's write path judges the token
itself.

So the risk is **integrity, not only confidentiality**. A refused token sees less, never more; but an
app that treats "empty" as "nothing exists" can act on it wrongly while its writes keep landing.
Model-benchmarking keeps in-flight run claims in `kv`: an empty read there could start a second paid
run for a claim that exists, spending Buzz twice. An app that seeds defaults when a collection is empty
can overwrite data that exists. A keyed `get` does not help: it reads the same stream.

**The guidance, and a cutover precondition:** state that must not be done twice is claimed with a
keyed `put` and `ifVersion: 0` (or the version last read), so a wrong "empty" makes the claim fail
with `version_conflict` instead of doing the work twice; defaults are seeded the same way. The app's
`kv.set` is an unconditional put today (`kv-store.ts:127-130`), and its run claims use it
(`src/App.tsx:2185`, `:2206`, `:2352`), so **moving the run claims to a conditional put is a
precondition of the cutover** (step 2).

The tracked fix is civitai/civitai-registry#56 (refuse a subscriber with an explicit error instead of
an empty snapshot). It must land, and the adapter adopt it, before REST sunsets.

## Who stays on REST

Ordinary `app` tokens and `hub` tokens (a hub-issued bearer of an approved app,
`doc-store-access.ts:89`, `:210`) of a cut-over app move: both are exchangeable (DESIGN.md "Tokens"),
and signed-out viewers move too ("Signed-out viewers"). What stays:

- **Dev, moderator-review and private-run tokens.** None has a registry read path: this service's
  verifier refuses a token with a dev, review or private-run marker (`DESIGN.md:151-157`), a review
  token stores in its own namespace (`doc-store-access.ts:152-185`), a dev token in the developer's
  (`:195-200`), and a private-run token gets no storage at all (`:12-15`). The cutover flag is
  evaluated only for a production token: the site hands the service URL to the block only then, and
  every other token keeps its current path. Test: a dev, review or private-run token for a cut-over
  app is never given the service URL, and its storage calls are answered as before.

They are counted (`token_kind` on the site's counter, below), so the end state can see them go to zero.

## Authn and authz

**v1 forwards the user's token** to the site's internal route. The site is already that token's
audience, and the read fallback already sends it there (`DESIGN.md:98-101`). This service checks
shape (slug, collection, key grammar, body size, op in scope) and verifies a block token locally, as for
reads (`exchange.BlockVerifier`), before forwarding a write, so a forged or expired token is refused
here (`401`, nothing forwarded); it routes by token shape as reads do
(`exchange.KindOf`), and decides no write access of its own (`DESIGN.md:17-18`). The rate buckets and
budgets stay per (app, principal) (`shared-storage-rate-limit.ts:139-190`). The site sees this
service's address, not the client's; nothing in the write path keys on the client address, a test pins
that, and the forward never passes a client-supplied `X-Forwarded-For` on.

An exchanged write token (`AppDataWrite`) is needed only if the writer ever leaves the site; it is
not v1.

## Hooks, charging, quotas, validation and moderation: parity

The internal route runs the same chain, so each gate runs in the same order on the same inputs.

| Gate | Where | Applies to | What to watch |
|---|---|---|---|
| API region block | the proxy's `apiRegionBlockMiddleware` on the public route; the internal route's own `internalRegionGate` (`doc-store-internal-route.ts`), on the signed forwarded region | every call | the same decision function (`getApiRegionBlock(getRegion(req))`), answering the same `451`; the proxy's matcher does not cover `/api/internal/`, and the page-only region restriction runs on neither route |
| Token, revocation, consent, `apps:storage` | `withBlockScope` (`block-scope.middleware.ts:1593`) | every call | the signature check runs before it and adds nothing to it |
| Publish scope | `assertPublishScope` (`doc-store-api.ts:847`, called `:1224`) | shared create, put | `consent_required` flows unchanged |
| Collection schema | `doc-store-api.ts:1236`, again in the store | create, put | none |
| `write` bucket | `doc-store-api.ts:1297-1299`; `shared-storage-rate-limit.ts:161-167` | private writes, every delete | same principal, same bucket |
| Trust gate | `assertTrusted` (`doc-store-api.ts:884`) | shared create, put | none |
| Shared-write budget | `reserveSharedWrite` (`shared-storage-rate-limit.ts:366`; called `doc-store-api.ts:1111`) | shared create, put | refunds pass through |
| Change-only charging | flag `app-blocks-storage-unchanged-writes-free` (`doc-store-api.ts:1302-1321`; #9166) | shared put | same code |
| Tally and report buckets | `shared-storage-rate-limit.ts:163-167` | marks | same principal |
| Permission hooks | `gateHook`, `doc-store-hook.ts` (#8126) | every write | the forward's timeout exceeds the hook client timeout (hook timeout + 450 ms, `doc-store-hook.ts:82-86`, `:106-113`) |
| Moderation | `moderate` (`doc-store-api.ts:978`; `:958-1064`) | shared create, put | an enforce refusal is `422 content_rejected`, passed through |
| Content levels | `SQL_RATING_PENDING` (`doc-store.ts:855`); `doc-levels.ts` | shared create, put | the writer's own pending record reaches only their per-viewer stream |
| Store-card sync | `syncStoreItem` (`doc-store-api.ts:1288`, `:1571`) | shared delete, unpublish | runs in the site, after the store |
| Publish | `_publish` / `_unpublish`, per-app flag, refused on hooked collections (`doc-store-api.ts:1427-1432`, `:1495`, `:1552`) | publish | the flag still gates it |
| Quotas | `usage_app` / `usage_user`, `413 quota_exceeded` (`doc-store.ts:2120-2161`) | every write | none |
| Buzz | none: the store charges no Buzz on writes (no Buzz call in `doc-store-api.ts` or `doc-store.ts`) | — | a future charge lands in the store, so in both |

## Schema versioning (D2)

A write is validated against the collection's current schema and stamped with the current major, in
the site. Only the current major is accepted: the site refuses a named `major` that is not the
collection's current one (`resolveSchemaMajor`, `409 stale_major`), and this service forwards the
`major` and relays that answer. Neither adds an upcast: the forward step chain has no production caller yet (`applyMajorChain`,
`storage-schema-majors.ts:309`, is called only by tests).

D2 is open question 2 of the registry's migrations proposal: how a stream at major N serves a
document written at N+1 ("Defaults and renames reverse cleanly; removals don't",
civitai-registry `proposals/migrations.md:62`). The proposal today keeps one body per entity and
drops a migrated body from the old major's stream as a `Delete` (`proposals/migrations.md:53`). It
decides what the adapter's streams serve, not what a write stores, and it is the spec's to decide.
The cutover app should not ship a breaking major during its 7-day window, and the window's metrics
should show it did not.

## Availability without a fallback

A cut-over app's reads and writes go through this service or fail; there is no REST fallback, during
the cutover window or after it. Availability comes from this service's own redundancy: two replicas
spread across nodes, a disruption budget that keeps one serving through a rollout, readiness that
turns false before a replica stops taking requests, and the sticky routing above re-hashing a lost
replica's tokens to the other. A write app-data-go refused before forwarding it (shutting down, or
any check of its own) answers `503 not_forwarded`, and only that code is safe to resend; a `503` from
the site (its unavailable codes, `doc-store-api.ts:283-287`) is treated as unknown. A write in flight on a replica that dies answers
`504 outcome=unknown` (or the connection drops): it may or may not have been forwarded, and the client
follows "Retries".

## Migration plan

The experimental-gateway-first rule covers what the registry gateways serve (registry reads and the
catalog), not this path: app-data-go reads the adapter directly, not through `registry-exp`
(`DESIGN.md:84-85`), and writes go to the site. So the writes need no gateway step of their own.

0. **Prerequisite: the reads are promoted.** The P4 shadow's gate (7 days of real-user comparisons
   under 0.1% mismatched, at least one non-empty compared list) is met, and S7 is promoted.
1. **Build, dark.** Behind `APP_DATA_WRITES` (default off: every write and shared-read route is `404`):
   - here: the write routes, `info`, the shared and keyed-get read routes, the level and per-viewer
     streams and their union, the signed-out read path, region forwarding, the base and overlay caches, the floors and the
     bounded reopen, block tokens held to one replica, sticky routing and the second replica;
   - the site: the internal route (signature, buffered body, the public `req.url`, the import refusal);
     the store changes; the app-wide mark sequence and its lock order; the counter below;
   - the adapter: `Entity.seq` and `k2`, both heads on every stream, the level streams and the per-viewer
     stream, the explicit refusal signal, their routing and bindings, the shared-level allowlist;
   - the hub: the fifth block-exchange claim, `civitai_viewer_browsing_level`, in the deploy order of
     "The level mask";
   - **a cut-over app's reads never fall back**: each of today's fallback reasons
     (`apps/app-data-go/internal/metrics/metrics.go:24-26`) gets its answer, for every read with
     `APP_DATA_WRITES` on (app-data-go evaluates no flag, decision 3 of the delta):

     | Reason | Answer for a cut-over app |
     |---|---|
     | `registry_off` | not possible: the flag requires the registry path; a misconfiguration is `503` |
     | `token_not_exchangeable`, `invalid_token` | `401` with the code, or the signed-out path for an anonymous block token |
     | `block_spent` | `401 block_token_spent`: the SDK refreshes the block token |
     | `block_cache_full`, `capacity`, `token_capacity`, `cooling_down` | `503` with `Retry-After` |
     | `exchange_refused` (including a `local` verifier refusal), `unverifiable` | `401` with the hub's code or `local`; `503` with `Retry-After` for `unverifiable` (a key-set outage) |
     | `not_live`, `stalled`, `ended`, `failed`, `closed` | `503` with `Retry-After` |
     | revoked (a stream closed as `revoked`), or a per-viewer refusal signal | `401 revoked` / `401 refused` |
     | `empty` | an empty answer ("The empty stream") |
     | `not_private` | not a fallback: shared collections are served by the level and per-viewer streams |
     | `too_large`, private stream | `503 too_large` for every read of that collection on that token. A private stream over its bound is closed (`DESIGN.md:336-337`), and a private collection is the user's own, so it is never served in part |
     | `too_large`, level stream | the window: list answers are unchanged for the app ("The bound is at least the app's own read"); a keyed `get` or `update` outside it is `503 too_large` |
     | `unkeyed` | `503`: an adapter without keys cannot serve a cut-over app, so the adapter release is a prerequisite |

   - **the site's counter**, which does not exist on `main`: `app_storage_requests_total{app, op, via,
     viewer, token_kind}`, `via` in `direct|service`, counted on both routes for every op. A series that
     does not exist reads as 0 in every query, so the cut-over app's `via="direct"` series are created
     at 0 when the flag is first evaluated for it.

   Tests, with pairwise-distinct fixtures: the forward sends the token and body unchanged and never
   retries; a request without a valid signature, or with a body that differs from the signed one,
   never reaches `withBlockScope`; an import through the internal route is `501`; a lost create answer
   is `504 outcome=unknown`; an acknowledged write and an acknowledged vote are read back before any
   poll; an acknowledgement older than the overlay or the base is ignored; an expired overlay shows the
   base, never nothing; a `Delete` of the overlay's URN drops it; `deleted: false` changes nothing; a
   re-created key wins over the old row's late upsert; a vote changes the tally and `viewer.marks` for
   the voter only; another viewer never sees the writer's pending record; a signed-out viewer never
   sees marks, authorship or a level bit outside its own; an anonymous token whose slug or approved
   block does not match, or that carries a dev, review or private-run marker, is refused; a refused
   signed-in viewer (the explicit signal) is answered `401 refused` from every level stream at once; the
   level streams' union holds each document once; with levels off, one stream serves every viewer; a write on token A never changes a read on token B; a read whose floor is
   above the head reopens once, then answers `503`; for a block token, a read whose floor this replica
   acknowledged itself is answered without a reopen, and for a hub token it is not; a `kv` read after a
   vote meets the mark floor against the app-wide mark head; a block token's write is forwarded with the hub
   unreachable; a levels-off stream ended by the adapter fails closed to the per-bit shape; a stream end, and an
   end with reason `not_resolved`, answer `503`, never `401`; a `Live` with no mask answers `401
   refused`; only `503 not_forwarded` is resent; a direct request to app-data-go carrying a forged region
   header has it stripped or is refused; a dev, review or
   private-run token is never given the service URL; a vote leaves the document's `seq` unchanged, and
   a moderator hide pinned to the pre-vote revision still applies.
2. **Cutover: model-benchmarking, all of its storage, directly.** No shadow step.
   - **Before the flag:** the app's run claims (and any default seeding) use a conditional put ("The
     empty stream"); the live value of `app-blocks-shared-doc-levels` for the app is read and the
     streams are sized for that mode; the `records` board fits the level-stream bound per bit and in
     total ("Size, count and alert"); every user's `kv` fits the private stream bounds, which are raised
     for the app to at least the largest tier's storage ceiling a user can hold (the default ceiling,
     2 MiB and 1,000 documents, `doc-store.types.ts:144-149`, equals the bounds today; a larger tier
     ceiling would exceed them); the edge-only check, owned by the cutover operator: a request sent to
     app-data-go directly with a forged region header has it stripped or is refused; and a positive control
     on the direct series: the app's `via="direct"` count is non-zero in the days before cutover, so a
     zero after it means the traffic moved, not that the counter is dead.
   - **The flag:** `app-data-writes-via-service` in Flipt, per app (entity the app block id, as the read
     shadow's flag). It moves the app's **reads, writes and `info`, private and shared, signed-in and
     signed-out**, to this service, through its public route, with CORS for the app's origin, for
     production tokens ("Who stays on REST").
   - **What the SDK changes at cutover:** every storage call targets this service; every read sends the
     floors; a read the registry cannot answer is an error (the table in step 1), retried with backoff
     on `503` and after a fresh block token on `401 block_token_spent`, never a REST read; an empty
     stream is an empty answer; `504 outcome=unknown` follows "Retries".
   - **Rollback:** the flag off; the SDK reads and writes the REST route again, and nothing moves, since
     the store is the only writer. This rollback is itself transitional: it exists only while the REST
     route does.
   - **Closing: model-benchmarking's storage goes only through the service for 7 days:**
     `app_storage_requests_total{app=<its block id>, via="direct", token_kind=~"app|hub"}` is 0 every
     day, for every op (reads, writes and `info`; private and shared; signed-in and signed-out); and
     `via="service"` is non-zero over the same days for reads, writes and `info`. The token kinds that
     stay on REST are reported beside it, not inside it.
3. **General.** Per app, the same flag, the same 7-day closing. Imports are a later turn-on with their
   own closing, by lifting the internal route's refusal.
4. **Remove app-data-go's read fallback.** See "End state". Not optional: REST cannot sunset while
   it exists.
5. **Sunset REST.** See "End state".

Registering the service in the registry (a service entity naming this route) is not v1: the flag
carries the URL until the SDK discovers it. Where such an entity is named is civitai/civitai-registry#57.

## End state: registry-only reads and writes, REST sunset

**The end state.** Apps read through app-data-go from the registry and write through app-data-go to
the store's internal route. The public REST App Storage API (`/api/v1/blocks/storage`,
`src/pages/api/v1/blocks/storage/[[...path]].ts`) is turned off.

**What must be true before REST is turned off:**

1. **Every app is cut over** (migration step 3 closed for every app with storage, imports included).
2. **Dev and review tokens have a path that is not the public route** (their own namespaces, served by
   the same internal chain or by this service).
3. **app-data-go's read fallback is removed** (`internal/rest`; `DESIGN.md:41-44`): the per-reason
   answers of step 1 apply to every app, and civitai/civitai-registry#56 has landed, so `empty` means
   empty.
4. **The read features REST has and streams do not** (filters, `author`, `mark`, other sorts) are
   served from the stream, or by an index over the registry.
5. **The P4 shadow is retired** (it compares against REST, `DESIGN.md:405-415`).
6. **The SDK** has no REST code path, discovers this service from the registry or the flag's URL,
   sends the floors, refreshes a spent block token, follows "Retries" and "The empty stream".
7. **Measured:** zero public REST App Storage requests, every verb, every app, every token kind, for 7
   days, with this service's reads and writes non-zero over the same days as the positive control. The
   per-app counter alone cannot show this: a request with no bearer token goes straight to the handler,
   and a `401` for an invalid one is not attributed to any app (`block-scope.middleware.ts:1608-1662`).
   So this step adds a route-level counter in front of `withBlockScope`, by method only, which counts
   every request the public route receives. Then the route answers `410` for a further window before
   it is deleted.

## Metrics

On this service (no label carries a token, user, app, collection or key, as the reads'):

- `app_data_writes_total{op,outcome}`: `op` in `create|put|delete|mark|unmark|increment|publish|unpublish|info`;
  `outcome` the store's status class, `refused_here`, `unknown`, `unavailable`;
- `app_data_write_forward_seconds{op}`;
- `app_data_cache_overlays_total{kind}` (`record`, `delete_marker`, `marks`) and
  `app_data_cache_stream_events_total{result}` (`applied`, `caught_up`, `older_kept`, `unordered`);
- `app_data_floor_reopens_total{outcome}` (`met`, `still_behind`, `spent`);
- `app_data_level_stream_records{bit}` against its bound, and `app_data_streams_open` against
  `MAX_STREAMS` (the alerts above);
- `app_data_signed_out_reads_total{outcome}`;
- **write-to-stream lag**, observed after cutover: the time from a write's acknowledgement to the first
  stream event at a sequence ≥ the write's, as a histogram. It sizes nothing; it measures how stale
  every other reader is.

On the site: `app_storage_requests_total{app,op,via,viewer,token_kind}` (step 1); the route-level
request counter (end state, item 7).

## Risks

1. **A second entry into the write chain that a later change makes asymmetric.** Mitigated by the
   internal route being the same chain, and by the test that lists those entries and every writer of
   `appdata.doc` (today `doc-store.ts` only).
2. **The internal route reached by something other than this service.** Refused without the
   signature; even then it grants no authority the user's token does not.
3. **A lost answer.** No retries; a keyed `put` with `ifVersion` is the only safe retry; a
   server-minted create's outcome stays unknown.
4. **A cache that serves a write the store does not hold.** Impossible by construction: an overlay is
   set only after the store's `2xx`. A stale answer is bounded by the overlays, the heads and the
   floors.
5. **The empty stream**: an integrity risk for apps that act on "empty", reduced by conditional claims,
   fixed by civitai/civitai-registry#56.
6. **Level streams are content shared across viewers.** The per-viewer stream gates who is served
   them, and a refusal is an explicit signal that drops the viewer from every level stream at once.
   Until the fifth claim is required, PG-13 reaches a viewer who turned it off.
7. **A board past its bound** keeps its newest documents per level stream, strictly above the app's own
   2,000-row read, so the app's lists are unchanged; a get or update outside the window is `503`.
   A private collection past its bound is `503`, never served in part.
8. **Sticky routing lost** (replica churn). Reads reopen once or answer `503`; a spent block token is
   refreshed by the SDK. Never REST; a stale read only in the accepted away-and-back residual.
9. **Reads depend on the hub exchange**: a hub outage stops new streams opening (writes need no
   exchange and keep working).
10. **No fallback means this service's outage is the apps' outage** for every cut-over app, taken
    knowingly; redundancy is the mitigation.
11. **Read-your-writes across tokens.** Two tabs of one user are two tokens and two streams; the second
    sees the first's write after one poll. Stated in the contract.

## Decided

Operator, 2026-11-22:

1. **Write path:** app-data-go forwards each write to the site's existing storage chain, through an
   internal-only route. The store stays the only writer; every gate applies by construction; apps get
   one service for reads and writes; the cutover is measured by the site's count of requests by path.
2. **No REST fallback, ever:** REST is to be sunset and the platform made registry-only, so nothing
   falls back to it. The read fallback is transitional and is removed before REST sunsets.
3. **Read-your-writes:** apply each acknowledged write to the stream cache, ordered by the store's
   sequences; a stream event replaces it only if not older.
4. **Service down:** a cut-over app's calls fail, during the cutover window and after it.
   Availability comes from the service's own redundancy.
5. **No shadow step:** model-benchmarking is cut over directly, with its Flipt flag as the rollback.
   The write-to-stream lag is a metric observed after cutover.
6. **Defaults taken:** v1 forwards the user's token (no new write scope yet); the current schema major
   only, else `409 stale_major`; no retries on forwarded writes (`504 outcome=unknown`); the site
   counts requests by path with a signed label, a count and the internal route's caller check, never a
   grant of user or app authority. (The default "v1 is private create, put and delete only" is
   superseded by 10.)
7. **Reads move too:** at the cutover the app's reads move with its writes, registry-only end to end.
8. **The experimental-gateway-first rule** covers registry-served reads and the catalog, not writes.
9. **Two replicas** with a disruption budget, and sticky routing by a header hash through a proxy that
   can hash on a header. The extra adapter stream budget is accepted.
10. **Shared collections are in v1:** append, update, withdraw, vote marks, publish, and the shared read
    path in app-data-go, so the whole app moves at once. This supersedes the "private only" default in 6.
11. **The empty stream is accepted for v1,** with the integrity risk stated and the conditional-claim
    precondition; civitai/civitai-registry#56 must land before REST sunsets.
12. **Signed-out viewers:** app-data-go reads the shared level streams under its own service identity,
    as an anonymous viewer (public levels only, no marks), and serves signed-out viewers from it.

Session, 2026-11-22:

13. **Private keyed get** is served from app-data-go's stream cache (base plus overlay), under the same
    floor rule.
14. **`info`** cannot come from a stream, so app-data-go forwards it through the same signed internal
    route to the store; the internal route carries the write verbs plus `info`.

## Open questions owned elsewhere

- **D2** (the portable-data owner, through the registry's migrations proposal): civitai-registry
  `proposals/migrations.md` open question 2.
- **Where a source's write endpoint is named** (the registry spec owner): civitai/civitai-registry#57.
- **Writes as a divergence from portable-data** (the portable-data owner): portable-data writes are
  signed ops posted to the namespace's node (`POST <node>/write`, its README); Civitai writes with
  block tokens, unsigned. Raised as J2 against JustMaier/portable-data#2.
- **Private data in the registry under auth** (the registry spec owner): answered in favor on
  civitai-registry#49; the per-user stream design the reads use is the answer to its Q2, and its
  answer asked for a short list of services allowed to hold such data, which the shared-level
  allowlist follows.
- **The relay stall** (the registry spec owner): civitai-registry#50. Not on the write path, which has
  no relay, but it bounds what the read-after-write contract can promise through a gateway.
- **Refusing a subscriber with an explicit error instead of an empty snapshot** (the registry spec
  owner): civitai/civitai-registry#56. Needed before the read fallback can be removed.
