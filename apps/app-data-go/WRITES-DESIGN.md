# app-data-go: the writes service (P3b), design

**Status:** design, decided by the operator on 2026-11-22 (see "Decided"); nothing built. This follows
the reads in [DESIGN.md](DESIGN.md), which lists "Any write path (P3b)" under "Not built"
(`DESIGN.md:568`). Direction from the operator (2026-11-19): the complete app platform runs via the
registry; writes go through a registered write service, scoped as a follow-up after reads;
everything ships on the experimental registry gateway (`registry-exp`) first.

**The overriding principle (operator, 2026-11-22):** "we cant fall back to rest because the plan is
to eventually sunset rest and be registry-only". No part of this design falls back to the public
REST App Storage API (`/api/v1/blocks/storage`): not for read-your-writes, not when this service is
down. app-data-go's existing read fallback to that API (`DESIGN.md:41-44`) is **transitional** and is
removed before REST is turned off ("End state" below).

## What is fixed before we start

1. **The registry protocol has no write.** It has one call, `Subscribe`, and only an entity's
   origin changes it (civitai-registry `spec/registry.md:3`, `:50-51`). Its design article puts writes
   at the source: "An entity never changes through a registry" (`docs/articles/design.md:311`); the
   app-with-forks scenario has a user write to app storage and the change reach the registry through
   the adapter (`docs/examples/scenarios/app-with-forks.md:45`). So "writes through the registry"
   means a write **service discovered through the registry**, never a write carried by one.
2. **The App Storage document store is the one writer.** Every write is one transaction in
   `doc-store.ts` (`src/server/services/apps/doc-store.ts:2211-2294`): lock the row, write, sync the
   index rows, charge `usage_app` (which hands out the next `seq`), charge `usage_user`, stamp the
   `seq`. Per (app, namespace) `seq` order is commit order (`doc-store.ts:104-106`).
3. **The registry adapter learns about writes only by polling the store.** No outbox, trigger or
   `NOTIFY`. The private feed re-reads one user's keyset of `(key, version, record_id)` and diffs it
   (`doc-store.ts:1033-1045`), every `REGISTRY_ADAPTER_POLL_SECONDS`, default 60 s
   (`src/server/registry-adapter/main.ts:144`). A write committed through `doc-store.ts` reaches the
   registry with no further work, within one poll.
4. **The write path's gates live in the site's storage handler**, in this order
   (`src/server/services/apps/doc-store-api.ts:1215-1300`): a signed-in viewer, the collection's
   write policy, the publish scope for a shared create or put, the body parse, the collection schema
   (`validateDocAgainstCollectionSchema`, again inside the store), owned model versions, the
   permission hook (`gateHook`, `doc-store-hook.ts`, calling the storage-hook-runner,
   `apps/storage-hook-runner/README.md:11-60`), the trust gate for shared writes, the write budget
   and rate buckets (`src/server/utils/shared-storage-rate-limit.ts:161-167`, `:277`), the moderation
   scan, then the store.
5. **The hub has no write scope.** `AppDataRead` is bit 32 (`packages/civitai-auth/src/token-scope.ts:115`);
   the block exchange issues exactly that (`apps/auth/src/lib/server/oauth/block-exchange.ts:97`), and
   the private feed requires it (`src/server/registry-adapter/private-feed.ts:103`).

## The write path

```
app ──► app-data-go (public)  ──►  the site's INTERNAL storage-write route  ──►  doc-store.ts
        POST/PUT/DELETE                (not reachable by apps)                       (the one writer)
        /v1/apps/{slug}/collections/{collection}/records[/{key}]
```

**The API.** The store's verbs and bodies, under this service's existing path, so an SDK swaps the
base URL and nothing else:

```
POST   /v1/apps/{slug}/collections/{collection}/records          {data}             create
PUT    /v1/apps/{slug}/collections/{collection}/records/{key}    {data, ifVersion?} put
DELETE /v1/apps/{slug}/collections/{collection}/records/{key}[?ifVersion=N]         delete
Authorization: Bearer <the app's token for the user>
→ the store's answer: status, error code and document as the store produced them, plus `seq`
```

Concurrency is the store's: an integer `ifVersion` (`0` = must not exist), `409 version_conflict`
with `currentVersion` (`doc-store.ts:2221-2237`); 64 KiB documents; the key and collection grammars of
`doc-store.types.ts:151-170`. A request naming a schema major other than the collection's current
one is `409 stale_major`; none named means current. Anything outside v1's scope ("Decided") is
`501 not_supported_here`.

**The internal route.** The forward does not call the public REST API. It calls an internal-only
route on the site that runs the same handler (`createStorageHandler`, `doc-store-api.ts:1682`) for the
write verbs:

- **not reachable by apps:** not exposed at the site's public edge, and refused unless the request
  carries this service's signature (HMAC over method, path, a body digest and a timestamp, the
  storage-hook-runner's scheme, `apps/storage-hook-runner/README.md:15-20`). The signature
  authenticates the **caller** (this service) only. It confers no user or app authority: that is
  still the user's token, judged by the handler exactly as on the public route
  (`resolveStorageAccess`, `doc-store-access.ts:141-215`; `apps:storage`; consent);
- **one handler, so every gate applies by construction:** the route is a second entry to the same
  code, not a copy of it. A test lists the entries into the write handler (the public route, this
  one) and fails if the set grows or shrinks;
- **its answer adds what the rev guard needs:** the written record's `seq`, and `record_id`, which
  the public route does not return (`presentDocs`, `doc-store-api.ts:746-784`, carries `version` but
  neither); a delete returns its tombstone's `seq`.

**Retries.** Never. A `create` without a key gets a server-picked key (`doc-store.ts:2348-2359`), so a
retried create after a lost answer writes twice. A forward that times out answers
`504 {outcome: "unknown"}`; the client reads before it writes again. An app that wants exactly-once
creates uses `put` with its own key and `ifVersion: 0`.

**Counting writes by path.** The public REST route counts each write by app,
`app_storage_writes_total{via="direct"}`, and the internal route `{via="service"}`. A cut-over app's
`direct` count must be zero; the internal route's count is the positive control that writes flow at
all.

## Source of truth and consistency

**Single writer.** Every write commits through `doc-store.ts`; this service holds no data but its
stream caches. There is no dual-write: the registry is not a store (fixed point 1), and a second
store would have no reconciler. A client sees the store's model: a write is acknowledged after
commit; writes to one key are ordered by `version` and refused by `ifVersion`. Rollback needs no data
movement, because nothing was ever written anywhere else.

## Read-your-writes: apply the write, rev-guarded

The adapter can lag a write by up to one poll. So this service applies each acknowledged write to its
own stream cache at once, tagged with the store's ordering number for that write, and a later stream
event for that record replaces it only if it is not older.

**What the adapter sends today, and why it cannot be the guard.** A private entity's `rev` is a
16-hex digest: `privateRev` hashes the body format `k1`, the key, and `docRev`, itself
`sha256({version, data, schemas})` (`src/server/registry-adapter/private-feed.ts:184-192`,
`src/server/registry-adapter/doc-feed.ts:147-148`). A digest says "changed", never "newer".

**What the store has.** Two numbers, of which only one is monotonic for a key:

- `doc.version` starts at 1 on insert and increments on update (`doc-store.ts` `SQL_INSERT_DOC`,
  `SQL_UPDATE_DOC`, around `:834-862`). A delete removes the row (`SQL_DELETE_DOC`), so a key deleted
  and created again starts at 1 again: monotonic within one row's life only;
- `doc.seq` comes from `usage_app.last_seq`, incremented under the quota row's lock by **every**
  write, private ones and deletes included (`SQL_CHARGE_APP`, `doc-store.ts:893-900`; `charge`,
  `:2120-2161`), stamped on the row (`SQL_STAMP_SEQ`, `:914`) and on a delete's tombstone
  (`SQL_TOMBSTONE`, `:937`; written in `delete`, `:2471-2477`). It is strictly increasing per (app,
  namespace) in commit order, across deletes and re-creates. **This is the guard.** Nothing new is
  needed in the store.

A re-created key is also a new row with a new `record_id` (default `gen_random_uuid()`,
`migrations/20261119120000_appdata_doc_record_id.sql`), so its URN differs from the deleted one's.
The cache therefore guards by **key** (which the private feed already carries, `protocol.ts` `Entity.key`),
not by URN.

**The adapter change (small).** The private feed's two queries also select `d.seq`
(`SQL_PRIVATE_FEED_VERSIONS` and `SQL_PRIVATE_FEED_DOCS`, `doc-store.ts:1033-1045`), and each
private entity carries it beside `key` (`Entity.seq`, HTTP binding only, as `key` is). The read
digest and `rev` stay as they are: a record's `seq` changes exactly when its `version` or body does,
so no cursor format change is needed.

**The rule in this service's cache** (per stream, keyed by record key):

| Event | Applied when |
|---|---|
| Acknowledged write (put or create) at `seq` S | always; the entry is `{key, data, version, seq: S, provisional}` |
| Acknowledged delete with tombstone `seq` S | always; the entry becomes a **delete marker** at S (read as absent) |
| Stream `Upsert` for the key at `seq` T | T ≥ the cached entry's `seq` (or no entry); it then replaces the entry, provisional or not |
| Stream `Delete` of a URN | it names the cached entry's own URN (the internal route returns `record_id`, so a provisional entry knows its URN); a `Delete` of the old row of a re-created key names another URN and is ignored. A URN can only be deleted after it was written, so a `Delete` of the entry's own URN is never older than it |
| A delete marker | dropped once a stream poll no longer lists the key, or one poll interval plus 30 s after it was set |

So a poll that started before the write delivers the old record (T < S) and is ignored; the poll that
sees the write delivers T = S and takes over. **A provisional entry the stream never confirms is
dropped** one poll interval plus 30 s after the write. That bounds the one case the stream cannot
correct: a refusal arrives as a `Delete` for every record the stream held (`DESIGN.md:229-230`), and a
record written since the last poll was never held, so no `Delete` names it. After the bound the
stream is authoritative again, as it is for everything else.

**Several replicas.** Each replica holds its own streams and caches (`DESIGN.md:316-320`). A write
acknowledged by replica A is in A's cache only; a read of the same token on replica B, through B's
own stream opened before the write, sees the write only after B's next poll. Answer: **no, not
without routing**. The fix:

- **Sticky routing by token** (consistent hashing on the `Authorization` header's digest at the
  service's load balancer). This is required anyway: a block token can be exchanged once
  (`DESIGN.md:169-184`), so only the replica that exchanged it can open a stream for it. Today a
  second replica's replay is refused and read from REST; with no REST fallback, that read would
  fail. Sticky routing makes the replica that took the write the one that serves the reads;
- **a version floor on reads, for when routing moves** (a replica restarted or removed): the write's
  answer carries `seq`; the SDK sends the highest `seq` it has seen for the collection on its next
  reads (`?minSeq=S`). A replica whose cache for that collection holds no record or marker at `seq`
  ≥ S reopens the stream (a new snapshot, below) before it answers, within `LIVE_WAIT_MS`; if it
  cannot, it answers `503` with `Retry-After`, never a stale list.

**A restart.** A replica's caches are in memory and are lost. Nothing is rebuilt from disk: the
first read after a restart opens a new stream, and a stream's first `Live` is a snapshot the adapter
reads from the store at that moment (`DESIGN.md:30-36`), which holds every write committed before
it. So read-your-writes holds across a restart, provided the read can open a stream at all: for a
block token whose one exchange was spent on the dead replica, it cannot, and the read answers
`401 block_token_spent`; the SDK gets a fresh block token from its host and retries (an SDK change,
"End state").

**The contract a client may rely on:** a write acknowledged by this service is in the store; a read
through this service on the same token afterwards returns it (with `minSeq`, also after routing
moved); a read on any other token, or of the registry directly, returns it within one adapter poll.

## Authn and authz

**v1 forwards the user's token** to the site's internal route. The site is already that token's
audience, and the read fallback already sends it there (`DESIGN.md:98-101`). This service checks
shape only (slug, collection, key grammar, body size, op in scope) so a malformed request never
reaches the site, and routes by token shape as reads do (`exchange.KindOf`); it decides no access of
its own (`DESIGN.md:17-18`). The rate buckets stay per (app, principal)
(`shared-storage-rate-limit.ts:139-190`), because the principal is still the user's token. The site
sees this service's address, not the client's; nothing in the write path keys on the client address,
a test pins that, and the forward never passes a client-supplied `X-Forwarded-For` on.

**When the writer leaves the site,** the user's token must not travel; it is exchanged as reads do.
That token is `AppDataWrite` (a new opt-in user scope, bit 33, excluded from `Full`, as
`token-scope.ts:109-116` gives `AppsRead` and `AppDataRead`), with `sub` the user, `client_id` the
app, `act.sub` the writer, and for a block token the four binding claims the block exchange writes
(`DESIGN.md:131-134`). Because a block token can be exchanged once, the read and write scopes would be
asked in one exchange; that is a change to the hub, the block exchange and the consent screen
together, and is not v1.

## Hooks, charging, quotas, validation and moderation: parity

The internal route runs the same handler, so each gate runs in the same order on the same inputs.

| Gate | Where | Parity | What to watch |
|---|---|---|---|
| Collection schema | `doc-store-api.ts:1236`, again in the store | same code | none |
| Permission hooks | `gateHook`, `doc-store-hook.ts` (#8126); the runner | same code; fail-closed `503 hook_unavailable` passes through | the forward's timeout exceeds the hook client timeout (hook timeout + 450 ms, `doc-store-hook.ts:82-86`, `:106-113`; at most 950 ms) |
| Rate buckets and write budget | `shared-storage-rate-limit.ts:161-167`, `:277` | same principal, same buckets | a second budget would be a bug |
| Change-only shared-write charging | flag `app-blocks-storage-unchanged-writes-free` (`doc-store-api.ts:1302-1321`; #9166) | same code | shared collections are out of v1 |
| Buzz | none: the store charges no Buzz on writes (no Buzz call in `doc-store-api.ts` or `doc-store.ts`) | n/a | a future per-write charge lands in the store, so in both |
| Quotas | conditional upserts on `usage_app` / `usage_user`, `413 quota_exceeded` (`doc-store.ts:2120-2161`) | same code | none |
| Moderation and content levels | shared writes only (`doc-store-api.ts:958-1064`) | same code | out of v1 |
| Schema major stamp | `withSchemaMajor` (`doc-store-api.ts:825-833`) | same code | `stale_major` is checked here, before the forward |

## Schema versioning (D2)

A write is validated against the collection's current schema and stamped with the current major, in
the site. This service accepts only the current major (`409 stale_major` otherwise), so it cannot
store a body under a major it does not satisfy, and it adds no upcast: the forward step chain has no
production caller yet (`applyMajorChain`, `storage-schema-majors.ts:309`, is called only by tests).

D2 is open question 2 of the registry's migrations proposal: how a stream at major N serves a
document written at N+1 ("Defaults and renames reverse cleanly; removals don't",
civitai-registry `proposals/migrations.md:62`). The proposal today keeps one body per entity and
drops a migrated body from the old major's stream as a `Delete` (`proposals/migrations.md:53`). It
decides what the adapter's **streams** serve, not what a write stores, and it is the spec's to
decide. Writes change one thing: every document a new-version client writes leaves the old-major
stream, so the cutover app should not ship a breaking major during its 7-day window, and the window's
metrics should show it did not.

## Availability without a fallback

A cut-over app's writes go through this service or fail; there is no REST fallback, during the
cutover window or after it. Availability comes from this service's own redundancy: at least two
replicas spread across nodes, a disruption budget that keeps one serving through a rollout, readiness
that turns false before a replica stops taking requests, and the sticky routing above re-hashing a
lost replica's tokens to the others. A write in flight on a replica that dies answers
`504 outcome=unknown` (or the connection drops); the client reads before it writes again, with
`minSeq` if it had an answer.

## Migration plan

Everything on the experimental gateway first, as the reads.

0. **Prerequisite: the reads are promoted.** The P4 shadow's gate (7 days of real-user comparisons
   under 0.1% mismatched, at least one non-empty compared list) is met, and S7 is promoted.
1. **Build, dark.** Behind `APP_DATA_WRITES` (default off: every write route is `404`): the write
   routes; the site's internal route and its signature check; the forward client; the adapter's
   `Entity.seq`; the rev-guarded cache; `minSeq`; sticky routing. Tests, with pairwise-distinct
   fixtures: the forward sends the token and body unchanged and never retries; a lost create answer
   is `504 outcome=unknown` and is never re-sent; a read after a write on the same token returns it
   before any poll; a stream upsert older than a cached write is ignored, a newer one replaces it; a
   delete marker hides the record until the stream agrees; a re-created key (new URN, higher `seq`)
   wins over the old record's late upsert; a write on token A never changes a read on token B; a read
   with `minSeq` above the cache reopens the stream, and answers `503` rather than a stale list if it
   cannot.
2. **Cutover: model-benchmarking, directly.** No shadow step. A per-app Flipt flag
   (`app-data-writes-via-service`, entity the app block id, as the read shadow's flag) tells the SDK
   to write through this service, through its public route, with CORS for the app's origin (the same
   work as P4's client-side reads, done once for both). **Rollback: the flag off**; the SDK writes the
   REST route again, and nothing moves, since the store is the only writer. This rollback is itself
   transitional: it exists only while the REST route does. **Closing: model-benchmarking writes only
   through the service for 7 days**: `app_storage_writes_total{via="direct"}` for the app is 0 every
   day, and `{via="service"}` is non-zero over the same days.
3. **General.** Per app, the same flag, the same 7-day closing. Shared collections, tallies, imports
   and publish are each a later turn-on with their own closing, by widening the scope check in step 1.
4. **Remove app-data-go's read fallback.** See "End state". Not optional: REST cannot sunset while
   it exists.
5. **Sunset REST.** See "End state".

**Registration.** Clients find the service through the registry: a service entity for the
`apps.civitai.com` namespace naming this route and its auth scheme, on the precedent of an existing
internal `service@v1` schema whose entities name a source's write endpoint. The adapter is that
namespace's origin, so it publishes the entity. Until the SDK discovers the endpoint from the
registry, the flag carries the URL; discovery is not on the cutover's critical path.

## End state: registry-only reads and writes, REST sunset

**The end state.** Apps read through app-data-go from the registry and write through app-data-go to
the store's internal route. The public REST App Storage API (`/api/v1/blocks/storage`,
`src/pages/api/v1/blocks/storage/[[...path]].ts`) is turned off.

**What must be true before REST is turned off:**

1. **Every app is cut over for writes** (migration step 3 closed for every app with storage,
   including shared collections, tallies, imports and publish, each with its own closing).
2. **app-data-go's read fallback is removed** (`internal/rest`; `DESIGN.md:41-44`). Each fallback
   reason (`internal/metrics`) needs a registry-only answer first:
   - `empty`: today an empty stream goes to REST because the origin answers a refused token with an
     empty `Live` (`DESIGN.md:60-63`). The adapter must instead refuse a refused subscriber with an
     error the service can tell from an empty collection (a spec question: it changes S2's "a
     refused subscriber learns nothing");
   - `capacity`, `token_capacity`, `not_live`, `stalled`, `cooling_down`: answer `503` with
     `Retry-After`, and size the stream caps and the adapter's subscription caps
     (`DESIGN.md:345-371`) so they do not bind in normal load;
   - `token_not_exchangeable`, `block_spent`, `block_cache_full`, `exchange_refused`: `401` with a
     code the SDK acts on (a fresh block token), or the hub refusal as is;
   - `not_private`: shared collections read from the adapter's public document feed through this
     service, which today serves only private collections (`DESIGN.md:65-79`);
   - stream size: `MAX_RECORDS_PER_STREAM` (1,000) and `MAX_BYTES_PER_STREAM` (2 MiB) send a large
     collection to REST today; registry-only needs paging or larger bounds;
   - the read features REST has and streams do not (filters, sorts, cursors, marks, author): served
     by this service from the stream, or by an index over the registry.
3. **The P4 shadow is retired** (it compares against REST, `DESIGN.md:405-415`).
4. **The SDK changes:** reads and writes target this service (discovered from the registry, or the
   flag's URL until then); writes send no major unless asked; it keeps the highest `seq` per
   collection and sends `minSeq`; it refreshes a spent block token on `401 block_token_spent`; it
   treats `504 outcome=unknown` as "read before writing again"; it has no REST code path.
5. **Measured:** zero public REST App Storage calls, reads and writes, for 7 days, on the site's
   per-route request count for `/api/v1/blocks/storage` (all verbs, all apps), with this service's
   `app_data_reads_total{source="registry"}` and `app_data_writes_total` non-zero over the same days
   as the positive control. Then the route answers `410` for a further window before it is deleted.

## Metrics

On this service (no label carries a token, user, app, collection or key, as the reads'):

- `app_data_writes_total{op,outcome}`: `op` in `create|put|delete`; `outcome` the store's status
  class, `refused_here`, `unknown`, `unavailable`;
- `app_data_write_forward_seconds{op}`;
- `app_data_cache_writes_applied_total{kind}` (`write`, `delete_marker`) and
  `app_data_cache_stream_events_total{result}` (`applied`, `older_ignored`);
- `app_data_min_seq_reopens_total{outcome}` (`caught_up`, `unavailable`);
- **write-to-stream lag**, observed after cutover: the time from a write's acknowledgement to the
  first stream event for that key at `seq` ≥ the write's, as a histogram. It no longer sizes anything
  (the rev guard has no window); it measures how stale every other reader is.

On the site: `app_storage_writes_total{op,via}` (above); the per-route request count for the public
storage route (the sunset measure).

## Risks

1. **A second entry into the write handler that a later change makes asymmetric.** Mitigated by the
   internal route being the same handler, and by the test that lists the handler's entries and every
   writer of `appdata.doc` (today `doc-store.ts` only) and fails if either set changes.
2. **The internal route reached by something other than this service.** Not exposed at the public
   edge, and refused without this service's signature; even then it grants no authority the user's
   token does not.
3. **Duplicate creates on a lost answer.** No retries, `outcome=unknown`, keyed `put` for
   exactly-once.
4. **A cache that serves a write the store does not hold.** Impossible by construction: an entry is
   applied only after the store's `2xx`. The opposite, a stale entry, is bounded by the rev guard and
   `minSeq`.
5. **Sticky routing lost** (replica churn). Reads with `minSeq` reopen or answer `503`; a spent block
   token is refreshed by the SDK. Never a stale list, never REST.
6. **No fallback means this service's outage is the apps' outage** for every cut-over app. That is
   the operator's trade, taken knowingly; redundancy ("Availability") is the mitigation.
7. **Read-your-writes across tokens.** Two tabs of one user are two tokens and two streams; the
   second sees the first's write after one poll. Stated in the contract.

## Decided

Operator, 2026-11-22:

1. **Write path:** app-data-go forwards each write to the site's existing storage handler, through an
   internal-only route. The store stays the only writer; every gate applies by construction; apps get
   one service for reads and writes; the cutover is measured by the site's count of writes by path.
2. **No REST fallback, ever:** "we cant fall back to rest because the plan is to eventually sunset
   rest and be registry-only". The read fallback is transitional and is removed before REST sunsets.
3. **Read-your-writes:** apply each acknowledged write to the stream cache, guarded by the store's
   per-record ordering (`seq`); a stream event replaces it only if not older. Needs the adapter's
   private feed to carry `seq`.
4. **Service down:** a cut-over app's writes fail, during the cutover window and after it.
   Availability comes from the service's own redundancy.
5. **No shadow step:** model-benchmarking is cut over directly, with its Flipt flag as the rollback.
   The write-to-stream lag is a metric observed after cutover.
6. **Defaults taken:**
   - v1 forwards the user's token; no new write scope yet. `AppDataWrite` stays the shape for when
     the writer leaves the site;
   - v1 scope is private-collection create, put and delete only;
   - the current schema major only, else `409 stale_major`;
   - no retries on forwarded writes: `504 outcome=unknown`;
   - the site counts writes by path with a signed label: a count, and the internal route's caller
     check, never a grant of user or app authority.

## Open questions owned elsewhere

- **D2** (Justin, the registry spec): civitai-registry `proposals/migrations.md` open question 2.
- **A write-endpoint entity in the protocol** (Koen): whether a source's service entity naming its
  write endpoint belongs in the registry spec or stays a Civitai schema. No issue yet.
- **Writes as a divergence from portable-data** (Justin): portable-data writes are signed ops
  posted to the namespace's node (`POST <node>/write`, its README); Civitai writes with block
  tokens, unsigned. Raised as J2 against JustMaier/portable-data#2.
- **Private data in the registry under auth** (Koen): answered in favor on civitai-registry#49;
  the per-user stream design the reads use is his answer to its Q2.
- **The relay stall** (Koen): civitai-registry#50. Not on the write path, which has no relay, but
  it bounds what the read-after-write contract can promise through a gateway.
