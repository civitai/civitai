# app-data-go: the writes service (P3b), design

**Status:** design, decided by the operator on 2026-11-22 (see "Decided"); nothing built. This follows
the reads in [DESIGN.md](DESIGN.md), which lists "Any write path (P3b)" under "Not built"
(`DESIGN.md:568`). Direction from the operator (2026-11-19): the complete app platform runs via the
registry, and writes go through a registered write service, as a follow-up after reads.

**The overriding principle (operator, 2026-11-22):** the public REST App Storage API
(`/api/v1/blocks/storage`) is to be sunset, leaving the platform registry-only, so nothing may fall
back to it. No part of this design does: not for read-your-writes, not when this service is down.
app-data-go's existing read fallback to that API (`DESIGN.md:41-44`) is **transitional** and is
removed before REST is turned off ("End state" below). The exceptions that stay on REST for now are
named, each with what ends it ("Who stays on REST").

**Scope of v1 (operator, 2026-11-22):** the first app, model-benchmarking, moves **all** of its
storage at once: its private `kv` collection and its shared `records` collection (`visibility:
shared`, `write: own`, `marks: [vote]`, scope `apps:storage:publish`; its `block.manifest.json`),
reads and writes. Code citations below are to civitai `main` at `1b3884df`; the app's to its `main`
at `65ce42f`.

## What is fixed before we start

1. **The registry protocol has no write.** It has one call, `Subscribe`, and only an entity's
   origin changes it (civitai-registry `spec/registry.md:3`, `:50-51`). Its design article puts writes
   at the source: "An entity never changes through a registry" (`docs/articles/design.md:311`); the
   app-with-forks scenario has a user write to app storage and the change reach the registry through
   the adapter (`docs/examples/scenarios/app-with-forks.md:45`). So "writes through the registry"
   means a write **service discovered through the registry**, never a write carried by one.
2. **The App Storage document store is the one writer.** Every document write is one transaction in
   `doc-store.ts` (`src/server/services/apps/doc-store.ts:2211-2294`): lock the row, write, sync the
   index rows, charge `usage_app` (which hands out the next `seq`), charge `usage_user`, stamp the
   `seq`. `usage_app` is keyed per (app, namespace) (`SQL_CHARGE_APP`, `doc-store.ts:893-900`), so
   the `seq` is one counter for every collection of the app, private and shared, and its order is
   commit order (`doc-store.ts:104-106`).
3. **The registry adapter learns about writes only by polling the store.** No outbox, trigger or
   `NOTIFY`. The private feed re-reads one user's keyset of `(key, version, record_id)` and diffs it
   (`doc-store.ts:1033-1045`); the shared feed reads `doc` and `doc_tomb` rows by `seq` range
   (`doc-store.ts:976-1026`). Both run every `REGISTRY_ADAPTER_POLL_SECONDS`, default 60 s
   (`src/server/registry-adapter/main.ts:144`).
4. **The write path's gates.** The route is `withBlockScope(withAxiom(createStorageHandler()))`
   (`src/pages/api/v1/blocks/storage/[[...path]].ts:29-36`). `withBlockScope`
   (`src/server/middleware/block-scope.middleware.ts:1593`) verifies the block JWT, its revocation and
   its consent, strips unconsented scopes, enforces `requiredScope: 'apps:storage'`, and sets
   `req.blockClaims`. The handler then runs, in this order (`src/server/services/apps/doc-store-api.ts:1215-1300`):
   a signed-in viewer, the collection's write policy, the publish scope for a shared create or put,
   the body parse, the collection schema (`validateDocAgainstCollectionSchema`, again inside the
   store), owned model versions; then, for a private write or any delete, the `write` rate bucket
   (`doc-store-api.ts:1297-1299`; `src/server/utils/shared-storage-rate-limit.ts:161-167`), or, for a
   shared create or put, the trust gate (`assertTrusted`, `doc-store-api.ts:884`) and the shared-write
   budget reservation (`reserveSharedWrite`, `:1111`; `shared-storage-rate-limit.ts:277`); then the
   permission hook (`gateHook`, `doc-store-hook.ts`), the moderation scan for a shared write
   (`moderate`, `doc-store-api.ts:978`), and the store, which for a shared write with content levels on
   marks the document pending (`SQL_RATING_PENDING`, `doc-store.ts:855`). A delete of a published
   shared item syncs its App Store card (`syncStoreItem`, `doc-store-api.ts:1288`).
5. **The hub has no app-data write scope.** `AppDataRead` is bit 32
   (`packages/civitai-auth/src/token-scope.ts:115`); the block exchange issues exactly that
   (`apps/auth/src/lib/server/oauth/block-exchange.ts:97`), and the private feed requires it
   (`src/server/registry-adapter/private-feed.ts:103`).

## What the app does with its storage

| App call (`src/lib/records-store.ts`, `src/lib/sdk-runtime.ts:533-535`) | Store op | Collection |
|---|---|---|
| `kv` `set`, `delete`, `list({prefix})`, `get` | put, delete, list by `keyPrefix`, get | `kv` (private) |
| `append` (`:240-246`) | create, server-minted key | `records` (shared) |
| `update` (`:248-262`) | get, then put with `ifVersion` | `records` |
| `withdraw` (`:265-267`) | delete | `records` |
| `vote` / `unvote` (`:269-273`) | `$mark` / `$unmark` `vote` | `records` |
| `report` (`:275-277`) | `$mark` `report` (built-in, never withdrawn) | `records` |
| `list` (`:224-236`, `src/App.tsx:4285`) | list, `sort: -key`, `limit` ≤ 100, `cursor` | `records` |

Each `records` item it reads uses `key`, `data`, `version`, `updatedAt`, `marks.vote` (the tally)
and `viewer.marks` ("did I vote"), and the author's identity only as "the reader wrote this"
(`records-store.ts:24-26`, `:72-78`). It does not call `_publish` or `_unpublish`, nor counters.

## The write path

```
app ──► app-data-go (public)  ──►  the site's INTERNAL storage route  ──►  doc-store.ts
                                       (not reachable by apps)              (the one writer)
```

**The API.** Every write the public storage route has, under this service's path, with the same
bodies, so an SDK swaps the base URL and nothing else:

```
POST   /v1/apps/{slug}/collections/{c}/records                 {data}              create (append)
PUT    /v1/apps/{slug}/collections/{c}/records/{key}           {data, ifVersion?}  put (update)
DELETE /v1/apps/{slug}/collections/{c}/records/{key}[?ifVersion=N]                 delete (withdraw)
PATCH  /v1/apps/{slug}/collections/{c}/records/{key}           one of {$inc}, {$mark}, {$unmark}
POST   /v1/apps/{slug}/publish/{to}                            {from, keys, prune?}
POST   /v1/apps/{slug}/unpublish/{to}                          {keys}
Authorization: Bearer <the app's token for the user>
→ the store's answer, status and error code as the store produced them, plus `seq` (see below)
```

Concurrency is the store's: an integer `ifVersion` (`0` = must not exist), `409 version_conflict`
with `currentVersion` (`doc-store.ts:2221-2237`); 64 KiB documents; the grammars of
`doc-store.types.ts:151-170`. Tallies do not change a document's `version`. A request naming a schema
major other than the collection's current one is `409 stale_major`; none named means current. The
current major is the newest major of the collection's schema family, which this service knows from
the collection schema URNs it streams (`urn:schema:apps.civitai.com:<slug>/<c>@v<N>`); the site
stamps its own major on every write anyway (`withSchemaMajor`, `doc-store-api.ts:825-833`), so a
stale view here can only refuse a write, never mis-stamp one. **Imports are not v1:** a write to
another app's collection answers `501 not_supported_here` (below).

**The internal route.** The forward does not call the public REST API. It calls an internal-only
route on the site, the public route's path under an `internal` prefix, that runs **the same middleware
chain as the public route**, `withBlockScope(withAxiom(createStorageHandler()))` with the same options
(`requiredScope: 'apps:storage'`), for the write verbs only. In order:

1. **Signature, before anything else.** The route lives on the same public-facing site processes as
   every other route, so a network policy cannot single it out; this signature is what keeps apps off
   it, and what makes the `via` count trustworthy. The request carries `x-app-data-ts` (unix seconds)
   and `x-app-data-sig` = hex HMAC-SHA256, with a key only this service and the site hold, over these
   five lines joined by `\n`: the method; the request path exactly as sent (no decoding or
   normalisation); the full raw query string (empty when there is none); the timestamp; and the hex
   SHA-256 of the raw body, which for an empty body is the SHA-256 of zero bytes
   (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). A timestamp more than 60 s
   from the site's clock, or a mismatch, is a `401` and nothing else runs.
2. **The body, buffered once.** The route disables Next's body parser as the public one does
   (`[[...path]].ts:22`), reads the raw body itself up to `STORAGE_BODY_LIMIT_BYTES`
   (`doc-store-api.ts:483`; over it a `413` in the storage envelope), hashes it for the signature, and
   hands the same bytes to the handler as the request stream, so `readJsonBody` (`:489`) reads what was
   signed.
3. **`withBlockScope`, unchanged.** The signature authenticates the **caller** (this service) only and
   confers no user or app authority: that is still the user's token, verified by `withBlockScope` and
   judged by the handler (`resolveStorageAccess`, `doc-store-access.ts:141-215`) exactly as on the
   public route. The route must never set `req.blockClaims` itself; only `withBlockScope`, after
   verifying the token, does.
4. **The target app.** This service forwards `from=<slug>` on every call. The handler treats a `from`
   naming the token's own app as an own call, identical to omitting it (`otherAppSource`,
   `doc-store-api.ts:1600-1611`), so the slug in the path can never name an app the token is not for
   without becoming an import. **The internal route refuses every import** (`otherAppSource` not null)
   with `501 not_supported_here`. The site must do this, not this service: only the site resolves which
   app the token was issued for, and this service never decodes a token.
5. **Its answer adds what the rev guard needs:** a create or put returns the record's `seq` and
   `record_id`; a delete returns its tombstone's `seq`; a mark or unmark returns its `seq` beside the
   count; a publish or unpublish returns each changed key's `seq`. The store returns none of these
   today ("Store changes").
6. **Audit rows stay comparable.** `withBlockScope` logs each authenticated call's endpoint through
   `normalizeEndpoint` (`block-scope.middleware.ts:2234`, `:2447`), which maps any segment it does not
   know to `:seg`. `internal` joins `KNOWN_STATIC_ENDPOINT_SEGMENTS` (`:2314`), and the route passes the
   public route's `endpoint` label (`storageEndpointLabel`), so a forwarded write reads as the same
   endpoint with a different `via`.

A test lists the `withBlockScope(… createStorageHandler …)` entries (the public route, this one) and
fails if the set grows or shrinks.

**Retries.** This service never retries a forward. A forward whose answer is lost answers
`504 {outcome: "unknown"}`, and **a read cannot prove the write did not happen**: it may commit after
the read, and a create with a server-minted key cannot even be looked for. The only safe retry is a
keyed `put` with `ifVersion` (`0` for a create, the version last read for an update), which the store
refuses with `409 version_conflict` if the first attempt landed. A mark or unmark is idempotent and
safe to resend. A server-minted create (the app's `append`) has no safe retry: the SDK surfaces the
unknown outcome, and the app's guidance is to mint its own key and `put` with `ifVersion: 0`, which a
`write: own` collection accepts (`records-store.ts:251`).

## Source of truth and consistency

**Single writer.** Every write commits through `doc-store.ts`; this service holds no data but its
stream caches. There is no dual-write: the registry is not a store (fixed point 1), and a second
store would have no reconciler. A client sees the store's model: a write is acknowledged after
commit; writes to one key are ordered by `version` and refused by `ifVersion`. Rollback needs no data
movement, because nothing was ever written anywhere else.

## The shared read path

**How shared collections stream today, and why app-data-go cannot serve `records` from it.**

- The adapter's shared document feed (`src/server/registry-adapter/doc-feed.ts`) streams a shared
  collection only when its app is listed and approved and its manifest opts the collection into the
  registry (`registry: "public"`, `doc-streams.ts:1-4`, `:30-36`). `records` does not opt in, so it
  has no stream at all.
- Where a collection is exported, its stream is everyone's: one per collection major and audience,
  narrowed by the app's rating and, with content levels on, by each document's level at the
  audience's level (`doc-feed.ts:34-40`, `:103-107`). It carries the document body only
  (`FeedDocument`, `:53-58`): no tallies, no viewer marks, no author. It never sends a `seq`, because
  private writes share the counter and a raw `seq` would tell their volume (`doc-feed.ts:9-11`,
  `:30-32`).
- A mark or unmark changes neither the document's `version` nor its `seq` (`mark`, `unmark`,
  `doc-store.ts:2565-2625`), so even an exported collection's stream would never carry a vote.

That is why `DESIGN.md:65-79` keeps app-data-go to private collections: the public feed is not the
REST list. The REST list is per viewer: each item's tallies, the viewer's own marks, whether the
viewer wrote it, and, with levels on, the viewer's own unrated documents, which only their author sees
(`sharedDocLevelVisible`, `doc-store.ts:771-777`).

**What is added: a per-viewer shared feed in the adapter.** An authorized stream, like the private
feed and beside it, serving one shared collection as the REST list would show it to one viewer:

- **auth** as the private feed's (`private-feed.ts`): a listed relay (`act.sub`), `AppDataRead`, the
  block token's binding claims (block, install, ceiling), and the app's read rule for that viewer
  (approved app, run gate); a shared collection is read by any eligible viewer of the app, not only
  its owner, so the collection-read predicate gains its shared branch. A refused viewer gets the
  private feed's answer (see "The empty stream");
- **content** as the store's list for that viewer: visible (`hidden_at` null), the level gate with
  the viewer's level for others' documents and the token's ceiling for the viewer's own
  (`sharedDocLevelVisible`), the app's rating against the viewer's audience and the token's ceiling.
  A moderator's hide is a tombstone with a `seq` (`doc-store.ts:4489-4493`), so it leaves the stream
  as a `Delete`; a re-rating that leaves the viewer's level likewise;
- **each entity** carries the body (the document, unchanged) and, beside it as `key` is today:
  `key`, `tallies` (counters and mark counts, the REST item's `counters` and `marks`), `viewer`
  (`{marks}`), `author` (`{isViewer}`, plus the username when the collection declares `showAuthor`),
  `level` and `ratingStatus` when levels are on, and `seq`;
- **isolation**: one stream per token, like the private streams, so one viewer's marks, authorship
  and unrated documents can never reach another (`DESIGN.md:316-320`).

It needs no `registry: "public"`: it is an authorized stream to a listed relay, not the public
catalog, and the public feed is unchanged.

**What app-data-go adds.** `GET …/records` and `GET …/records/{key}` for shared collections, answered
from that stream's cache: `sort: key` or `-key`, `limit` (at most 100, the store's), and a key-based
`cursor`; the item shape is the REST item's, so the app's `toSharedRecord` reads it unchanged. Other
list parameters (filters, `author`, `mark`, other sorts) are not v1 and answer `501
not_supported_here`; the app uses none of them.

**Load.** A board is read whole by every viewer's stream, so a stream holds the whole collection as
that viewer sees it. Before cutover, the collection's size, read from the store, must fit the stream
bounds (`MAX_RECORDS_PER_STREAM`, `MAX_BYTES_PER_STREAM`), or the bounds are raised for it: a stream
that outgrows them can no longer send the read to REST. Sharing one base stream per (collection,
audience) across viewers, with per-viewer facts layered on, is the lever if this binds; it is not v1,
because it makes this service the judge of which viewer may see the base.

## Read-your-writes: the store's `seq`, base and overlay

The adapter can lag a write by up to one poll. So this service applies each acknowledged write to the
writing token's stream cache at once, ordered by the store's `seq`.

**Why `rev` cannot be the guard.** A private entity's `rev` is a 16-hex digest (`privateRev`,
`private-feed.ts:184-192`, over `docRev`, `doc-feed.ts:147-148`): it says "changed", never "newer".
`doc.version` restarts at 1 when a key is deleted and created again (`SQL_INSERT_DOC`,
`SQL_DELETE_DOC`, around `doc-store.ts:834-862`), and a re-created key is a new row with a new
`record_id` and so a new URN. `doc.seq` is strictly increasing per (app, namespace) across every
write, deletes included (stamped on the row, `SQL_STAMP_SEQ`, `:914`, and on a tombstone,
`SQL_TOMBSTONE`, `:937`). **The guard is `seq`, per key.**

**Whose `seq`, and the head.** One counter per app namespace, shared by `kv` and `records`, private
and shared writes alike (fixed point 2). The **head**, `usage_app.last_seq` (`SQL_FEED_HEAD`,
`doc-store.ts:981`), is therefore per app namespace too, not per collection: a stream's head says
"every write of this app at or below it is in what this poll read", for every collection. A
collection with no write past a reader's floor is satisfied by any head at or above the floor.

**Store changes.** The column exists but the store's API does not return it: `DocRecord`
(`doc-store.types.ts:90-103`) has no `seq` or `recordId`, `docColumns` (`doc-store.ts:691-700`)
selects neither, and `delete` returns only `{deleted}` (`doc-store.ts:2440-2480`). So:

- `create` and `put` return `seq` and `record_id`; `delete` returns `{deleted: true, seq}`. A delete
  that finds nothing (`{deleted: false}`) has no `seq` and wrote no tombstone: the cache applies
  nothing;
- `mark`, `unmark` and `increment` take a `seq` (the no-charge `charge` the moderator hide uses,
  `doc-store.ts:4489-4493`) and stamp it on the document, so the feeds see a tally change; the
  document's `version` is unchanged, so `ifVersion` keeps its meaning. The shared feed's `rev`
  includes the tallies, so a vote re-sends the record;
- `publishCopies` and `unpublishCopies` already number their documents (`SQL_CHARGE_APP_SEQS`,
  `doc-store.ts:1434-1446`); they return each key's `seq`;
- the public route's `presentDocs` keeps exposing none of these.

**Adapter changes.**

- The private feed's queries also select `d.seq` (`SQL_PRIVATE_FEED_VERSIONS`,
  `SQL_PRIVATE_FEED_DOCS`, `doc-store.ts:1033-1045`), and each entity carries it beside `key`
  (`Entity.seq`, HTTP binding only, as `key` is). The per-viewer shared feed carries it from the
  start.
- `PRIVATE_BODY_FORMAT` goes from `k1` to `k2` (`private-feed.ts:176-182`): it is folded into every
  private `rev` and the read digest, so a cursor saved before the change resumes as a change and every
  record is sent again with its `seq`. No cursor is expired.
- Each poll reads the head in the same transaction as the keyset read, or before it, never after (a
  head read after could name a write the keyset missed), and carries it on `Live` and on each change
  batch's `Progress` (in `meta`).
- `seq` and the head are sent only on these authorized streams, to a listed relay, and this service
  passes neither to apps except a write's own `seq` in its answer. **Accepted:** the head (and a
  write's `seq`) tells its holder the app's whole write volume between two reads, every user's
  included.

**The cache: a base and an overlay per key.** The **base** is what the stream last said; the
**overlay** is what this token's acknowledged writes said since. A read answers the overlay where one
exists, else the base. They are never merged into one value, so dropping an overlay shows the base
again, never a vanished record.

| Event | Effect |
|---|---|
| Acknowledged write (create, put, mark, unmark) at `seq` S | the overlay for the key becomes the answer's record at S, only if S ≥ the overlay's `seq` and S ≥ the base's `seq` (an answer can arrive after a later write's) |
| Acknowledged delete at tombstone `seq` S | the overlay becomes a **delete marker** at S, under the same rule (read as absent) |
| `deleted: false` | nothing |
| Stream `Upsert` for the key at `seq` T | replaces the base; the overlay is dropped once T ≥ its `seq` (the stream has caught up) |
| Stream `Upsert` with no `seq` (an adapter before `k2`) | replaces the base only; it never drops or outranks an overlay |
| Stream `Delete` of the base's URN | removes the base; drops a delete-marker overlay. A `Delete` of another URN (the old row of a re-created key) is ignored |
| An overlay the stream has not caught up with | dropped one poll interval plus 30 s after it was set, showing the base |

The last row bounds the case the stream cannot correct: a refusal arrives as a `Delete` for every
record the stream held (`DESIGN.md:229-230`), and a record written since the last poll was never held.
An overlay is per token: another viewer of a shared collection sees a write only when the store does
show it to them (rated, not hidden) and their own stream says so.

**Several replicas.** v1 runs two replicas with a disruption budget. Each holds its own streams and
caches. A write acknowledged by replica A is in A's cache only; a read of the same token on replica B,
through B's own stream opened before the write, sees it only after B's next poll. Answer: **no, not
without routing**. The fix:

- **Sticky routing by token:** consistent hashing on a digest of the `Authorization` header. That
  needs a proxy in front of the replicas that hashes on a request header; a plain round-robin service
  address cannot do it. It is required anyway: a block token can be exchanged once
  (`DESIGN.md:169-184`), so only the replica that exchanged it can open a stream for it. Two replicas
  can each hold a stream for the same user while routing moves; that extra adapter stream budget is
  accepted;
- **a floor on reads, for when routing moves:** each answer carries `seq`; the SDK sends the highest
  it has seen for the app on its next reads (`?minSeq=S`). A replica answers from a stream **only when
  that stream's last head is ≥ S**. Otherwise it reopens the stream (a new snapshot, whose `Live`
  carries a fresh head), at most once per (token, collection) per poll interval, within
  `LIVE_WAIT_MS`. If the reopened stream's head is still below S, or a reopen was already spent in
  this interval, it answers `503` with `Retry-After` and does not reopen again. The floor covers
  acknowledged writes only: a write still in flight when a read starts may or may not be in that
  read's answer, as on REST.

**A restart.** Caches are in memory and are lost. Nothing is rebuilt from disk: the first read opens a
new stream, whose first `Live` is a snapshot the adapter reads from the store at that moment
(`DESIGN.md:30-36`), holding every committed write and carrying a head that satisfies any earlier
floor. A block token whose one exchange was spent on the dead replica cannot open a stream: the read
answers `401 block_token_spent`, and the SDK gets a fresh block token from its host and retries once.

**The contract a client may rely on:** a write acknowledged by this service is in the store; a read
through this service on the same token afterwards returns it (with `minSeq`, also after routing
moved); any other token, or another viewer of a shared collection, sees it within one adapter poll of
the store showing it to them.

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
run for a claim that exists, spending Buzz twice. An app that seeds defaults when a collection is
empty can overwrite data that exists.

**SDK guidance, shipped with the cutover:**

- never treat an empty **first** snapshot after cutover (or after a reopen) as authoritative for a
  destructive or charging decision: confirm with a keyed `get`, which returns the record or a
  `not_found` the app can act on;
- write state that must not be duplicated with a keyed `put` and `ifVersion: 0` (a claim), so a
  wrong "empty" makes the write fail with `version_conflict` instead of doing the work twice;
- seed defaults the same way, never with an unconditional `put`.

The tracked fix is civitai/civitai-registry#56 (refuse a subscriber with an explicit error instead of
an empty snapshot). It must land, and the adapter adopt it, before REST sunsets.

## Who stays on REST

- **Dev, moderator-review and private-run tokens.** None has a registry read path: this service's
  verifier refuses a token with a dev, review or private-run marker (`DESIGN.md:151-157`), a review
  token stores in its own namespace (`doc-store-access.ts:152-185`), a dev token in the developer's
  (`:195-200`), and a private-run token gets no storage at all (`:12-15`). The cutover flag is
  evaluated only for an ordinary production token: the site hands the service URL to the block only
  then, and every other token keeps its current path. Test: a dev, review or private-run token for a
  cut-over app is never given the service URL, and its storage calls are answered as before.
- **Anonymous viewers** of a shared collection. The block exchange needs a signed-in subject, so an
  anonymous viewer has no token this service can exchange, and no registry read path. They keep
  reading REST until a public path exists (see "Still open").

Each is counted (`viewer` and `token_kind` on the site's counter, below), so the end state can see
them go to zero.

## Authn and authz

**v1 forwards the user's token** to the site's internal route. The site is already that token's
audience, and the read fallback already sends it there (`DESIGN.md:98-101`). This service checks
shape only (slug, collection, key grammar, body size, op in scope), routes by token shape as reads do
(`exchange.KindOf`), and decides no access of its own (`DESIGN.md:17-18`). The rate buckets and
budgets stay per (app, principal) (`shared-storage-rate-limit.ts:139-190`), because the principal is
still the user's token. The site sees this service's address, not the client's; nothing in the write
path keys on the client address, a test pins that, and the forward never passes a client-supplied
`X-Forwarded-For` on.

An exchanged write token (`AppDataWrite`) is needed only if the writer ever leaves the site; it is
not v1.

## Hooks, charging, quotas, validation and moderation: parity

The internal route runs the same chain, so each gate runs in the same order on the same inputs.

| Gate | Where | Applies to | What to watch |
|---|---|---|---|
| Token, revocation, consent, `apps:storage` | `withBlockScope` (`block-scope.middleware.ts:1593`) | every call | the signature check runs before it and adds nothing to it |
| Publish scope | `assertPublishScope` (`doc-store-api.ts:1224`) | shared create, put | consent prompt flows unchanged (`consent_required`) |
| Collection schema | `doc-store-api.ts:1236`, again in the store | create, put | none |
| `write` bucket | `doc-store-api.ts:1297-1299`; `shared-storage-rate-limit.ts:161-167` | private writes, every delete | same principal, same bucket |
| Trust gate | `assertTrusted` (`doc-store-api.ts:884`) | shared create, put | none |
| Shared-write budget | `reserveSharedWrite` (`doc-store-api.ts:1111`; `shared-storage-rate-limit.ts:277`) | shared create, put | refunds on a write that does not land pass through |
| Change-only charging | flag `app-blocks-storage-unchanged-writes-free` (`doc-store-api.ts:1302-1321`; #9166) | shared put | same code |
| Tally and report buckets | `shared-storage-rate-limit.ts:163-167` | marks | same principal |
| Permission hooks | `gateHook`, `doc-store-hook.ts` (#8126) | every write | the forward's timeout exceeds the hook client timeout (hook timeout + 450 ms, `doc-store-hook.ts:82-86`, `:106-113`) |
| Moderation | `moderate` (`doc-store-api.ts:978`; `:958-1064`) | shared create, put | an enforce refusal is `422 content_rejected`, passed through |
| Content levels | `SQL_RATING_PENDING` (`doc-store.ts:855`); `doc-levels.ts` | shared create, put | the writer's own pending record reaches only their own stream |
| Store-card sync | `syncStoreItem` (`doc-store-api.ts:1288`, `:1571`) | shared delete, unpublish | runs in the site, after the store |
| Publish | `_publish` / `_unpublish`, per-app flag, refused on hooked collections (`doc-store-api.ts:1427-1432`, `:1495`, `:1552`) | publish | the flag still gates it; the app does not call it today |
| Quotas | `usage_app` / `usage_user`, `413 quota_exceeded` (`doc-store.ts:2120-2161`) | every write | none |
| Buzz | none: the store charges no Buzz on writes (no Buzz call in `doc-store-api.ts` or `doc-store.ts`) | — | a future charge lands in the store, so in both |

## Schema versioning (D2)

A write is validated against the collection's current schema and stamped with the current major, in
the site. This service accepts only the current major (`409 stale_major` otherwise) and adds no
upcast: the forward step chain has no production caller yet (`applyMajorChain`,
`storage-schema-majors.ts:309`, is called only by tests).

D2 is open question 2 of the registry's migrations proposal: how a stream at major N serves a
document written at N+1 ("Defaults and renames reverse cleanly; removals don't",
civitai-registry `proposals/migrations.md:62`). The proposal today keeps one body per entity and
drops a migrated body from the old major's stream as a `Delete` (`proposals/migrations.md:53`). It
decides what the adapter's **streams** serve, not what a write stores, and it is the spec's to
decide. Writes change one thing: every document a new-version client writes leaves the old-major
stream, so the cutover app should not ship a breaking major during its 7-day window, and the window's
metrics should show it did not.

## Availability without a fallback

A cut-over app's reads and writes go through this service or fail; there is no REST fallback, during
the cutover window or after it. Availability comes from this service's own redundancy: two replicas
spread across nodes, a disruption budget that keeps one serving through a rollout, readiness that
turns false before a replica stops taking requests, and the sticky routing above re-hashing a lost
replica's tokens to the other. A write in flight on a replica that dies answers `504
outcome=unknown` (or the connection drops); the client follows "Retries".

## Migration plan

The experimental-gateway-first rule covers what the registry gateways serve (registry reads and the
catalog), not this path: app-data-go reads the adapter directly, not through `registry-exp`
(`DESIGN.md:84-85`), and writes go to the site. So the writes need no gateway step of their own.

0. **Prerequisite: the reads are promoted.** The P4 shadow's gate (7 days of real-user comparisons
   under 0.1% mismatched, at least one non-empty compared list) is met, and S7 is promoted.
1. **Build, dark.** Behind `APP_DATA_WRITES` (default off: every write route is `404`):
   - the write routes and the shared read routes here; the forward client; the base/overlay cache;
     `minSeq` and the bounded reopen; sticky routing and the second replica;
   - the site's internal route (signature, buffered body, the import refusal, the endpoint label);
   - the store changes (`seq` and `record_id` returned; marks take a `seq`);
   - the adapter's `Entity.seq`, `k2`, the head, and the per-viewer shared feed;
   - **the site's counter**, which does not exist on `main`: `app_storage_requests_total{app, op,
     via, viewer, token_kind}`, `via` in `direct|service`, counted on both routes for reads and
     writes. A series that does not exist reads as 0 in every query, so the cut-over app's
     `via="direct"` series are created at 0 when the flag is first evaluated for it.

   Tests, with pairwise-distinct fixtures: the forward sends the token and body unchanged and never
   retries; a request without a valid signature, or with a body that differs from the signed one,
   never reaches `withBlockScope`; an import through the internal route is `501`; a lost create
   answer is `504 outcome=unknown`; an acknowledged write is read back before any poll; an
   acknowledgement older than the overlay or the base is ignored; a stream upsert older than an
   overlay keeps the overlay, a caught-up one drops it; an expired overlay shows the base, never
   nothing; `deleted: false` changes nothing; a re-created key wins over the old row's late upsert; a
   vote's overlay changes the tally and `viewer.marks` for the voter only; another viewer never sees
   the writer's pending record; a write on token A never changes a read on token B; a read with
   `minSeq` above the head reopens once, then answers `503`; a dev, review or private-run token is
   never given the service URL.
2. **Cutover: model-benchmarking, all of its storage, directly.** No shadow step.
   - **Before the flag:** the `records` collection's size fits the stream bounds; and a positive
     control on the direct series: the app's `via="direct"` count is non-zero in the days before
     cutover, so a zero after it means the traffic moved, not that the counter is dead.
   - **The flag:** `app-data-writes-via-service` in Flipt, per app (entity the app block id, as the
     read shadow's flag). It moves the app's **reads and writes, private and shared**, to this
     service, through its public route, with CORS for the app's origin, for ordinary signed-in tokens
     ("Who stays on REST").
   - **What the SDK changes at cutover:** every storage call targets this service; every read sends
     `minSeq`; a read the registry cannot answer is an error (`503` with `Retry-After`, retried with
     backoff; `401 block_token_spent`, a fresh block token and one retry), never a REST read; an empty
     stream is an empty answer, under "The empty stream" guidance; `504 outcome=unknown` follows
     "Retries".
   - **Rollback:** the flag off; the SDK reads and writes the REST route again, and nothing moves,
     since the store is the only writer. This rollback is itself transitional: it exists only while
     the REST route does.
   - **Closing: model-benchmarking's storage goes only through the service for 7 days:**
     `app_storage_requests_total{app=<its block id>, via="direct", viewer="signed_in",
     token_kind="app"}` is 0 every day, for reads and writes, private and shared; and `via="service"`
     is non-zero over the same days, for reads and writes. The excluded viewers are reported beside
     it, not inside it.
3. **General.** Per app, the same flag, the same 7-day closing. Imports are a later turn-on with
   their own closing, by lifting the internal route's refusal.
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
2. **The exceptions are gone:** dev and review tokens have a path that is not the public route
   (their own namespaces, served by the same internal chain or by this service), and anonymous
   viewers have a public read path ("Still open").
3. **app-data-go's read fallback is removed** (`internal/rest`; `DESIGN.md:41-44`). Each fallback
   reason (`internal/metrics`) needs a registry-only answer first:
   - `empty`: civitai/civitai-registry#56 lands, so a refused subscriber gets an error, not an empty
     snapshot (`DESIGN.md:60-63`);
   - `capacity`, `token_capacity`, `not_live`, `stalled`, `cooling_down`: `503` with `Retry-After`,
     with the stream caps and the adapter's subscription caps (`DESIGN.md:345-371`) sized so they do
     not bind in normal load;
   - `token_not_exchangeable`, `block_spent`, `block_cache_full`, `exchange_refused`: `401` with a
     code the SDK acts on, or the hub refusal as is;
   - `not_private`: answered by the per-viewer shared feed;
   - stream size: `MAX_RECORDS_PER_STREAM` and `MAX_BYTES_PER_STREAM` sized per app, or paging;
   - the read features REST has and streams do not (filters, `author`, `mark`, other sorts): served
     from the stream, or by an index over the registry.
4. **The P4 shadow is retired** (it compares against REST, `DESIGN.md:405-415`).
5. **The SDK** has no REST code path, discovers this service from the registry or the flag's URL,
   keeps the highest `seq` and sends `minSeq`, refreshes a spent block token, follows "Retries" and
   "The empty stream".
6. **Measured:** zero public REST App Storage requests, every verb, every app, every viewer and token
   kind, for 7 days, with this service's reads and writes non-zero over the same days as the positive
   control. The per-app counter alone cannot show this: a request with no bearer token goes straight
   to the handler, and a `401` for an invalid one is not attributed to any app
   (`block-scope.middleware.ts:1608-1662`). So this step adds a route-level counter in front of
   `withBlockScope`, by method only, which counts every request the public route receives. Then the
   route answers `410` for a further window before it is deleted.

## Metrics

On this service (no label carries a token, user, app, collection or key, as the reads'):

- `app_data_writes_total{op,outcome}`: `op` in `create|put|delete|mark|unmark|increment|publish|unpublish`;
  `outcome` the store's status class, `refused_here`, `unknown`, `unavailable`;
- `app_data_write_forward_seconds{op}`;
- `app_data_cache_overlays_total{kind}` (`write`, `delete_marker`) and
  `app_data_cache_stream_events_total{result}` (`applied`, `caught_up`, `older_kept`, `unordered`);
- `app_data_min_seq_reopens_total{outcome}` (`caught_up`, `still_behind`, `spent`);
- **write-to-stream lag**, observed after cutover: the time from a write's acknowledgement to the
  first stream event for that key at `seq` ≥ the write's, as a histogram. It sizes nothing; it
  measures how stale every other reader is.

On the site: `app_storage_requests_total{app,op,via,viewer,token_kind}` (step 1); the route-level
request counter (end state, step 6).

## Risks

1. **A second entry into the write chain that a later change makes asymmetric.** Mitigated by the
   internal route being the same `withBlockScope(… createStorageHandler …)` chain, and by the test
   that lists those entries and every writer of `appdata.doc` (today `doc-store.ts` only).
2. **The internal route reached by something other than this service.** Refused without the
   signature; even then it grants no authority the user's token does not.
3. **A lost answer.** No retries; a keyed `put` with `ifVersion` is the only safe retry; a
   server-minted create's outcome stays unknown.
4. **A cache that serves a write the store does not hold.** Impossible by construction: an overlay is
   set only after the store's `2xx`. A stale answer is bounded by the overlay, the head and `minSeq`.
5. **The empty stream** ("The empty stream"): an integrity risk for apps that act on "empty",
   reduced by the SDK guidance, fixed by civitai/civitai-registry#56.
6. **Shared streams' size and count.** Every viewer of a shared collection holds a stream of the
   whole collection; bounded by the stream caps, measured before cutover.
7. **Sticky routing lost** (replica churn). Reads with `minSeq` reopen once or answer `503`; a spent
   block token is refreshed by the SDK. Never a stale list, never REST.
8. **No fallback means this service's outage is the apps' outage** for every cut-over app, taken
   knowingly; redundancy is the mitigation.
9. **Read-your-writes across tokens.** Two tabs of one user are two tokens and two streams; the
   second sees the first's write after one poll. Stated in the contract.

## Decided

Operator, 2026-11-22:

1. **Write path:** app-data-go forwards each write to the site's existing storage chain, through an
   internal-only route. The store stays the only writer; every gate applies by construction; apps get
   one service for reads and writes; the cutover is measured by the site's count of requests by path.
2. **No REST fallback, ever:** REST is to be sunset and the platform made registry-only, so nothing
   falls back to it. The read fallback is transitional and is removed before REST sunsets.
3. **Read-your-writes:** apply each acknowledged write to the stream cache, guarded by the store's
   `seq`; a stream event replaces it only if not older. Needs the store to return `seq` and the
   adapter to carry it.
4. **Service down:** a cut-over app's calls fail, during the cutover window and after it.
   Availability comes from the service's own redundancy.
5. **No shadow step:** model-benchmarking is cut over directly, with its Flipt flag as the rollback.
   The write-to-stream lag is a metric observed after cutover.
6. **Defaults taken:** v1 forwards the user's token (no new write scope yet); the current schema major
   only, else `409 stale_major`; no retries on forwarded writes (`504 outcome=unknown`); the site
   counts requests by path with a signed label, a count and the internal route's caller check, never
   a grant of user or app authority. (The default "v1 is private create, put and delete only" is
   superseded by 10.)
7. **Reads move too:** at the cutover the app's reads move with its writes, registry-only end to end.
8. **The experimental-gateway-first rule** covers registry-served reads and the catalog, not writes.
9. **Two replicas** with a disruption budget, and sticky routing by a header hash through a proxy
   that can hash on a header. The extra adapter stream budget is accepted.
10. **Shared collections are in v1:** append, update, withdraw, vote marks, publish, and the shared
    read path in app-data-go, so the whole app moves at once. This supersedes the "private only"
    default in 6.
11. **The empty stream is accepted for v1,** with the integrity risk stated and the SDK guidance
    above; civitai/civitai-registry#56 must land before REST sunsets.

## Still open

- **Anonymous viewers' shared reads** (operator): they have no registry read path. Options: keep them
  on REST until the end state (recommended for v1, counted, so the closing excludes them openly); or
  have the app opt `records` into `registry: "public"` and serve anonymous reads from the public feed
  through this service, which needs tallies on the public feed and exposes the board to every
  registry reader, not only the app's viewers.

## Open questions owned elsewhere

- **D2** (the portable-data owner, through the registry's migrations proposal): civitai-registry
  `proposals/migrations.md` open question 2.
- **Where a source's write endpoint is named** (the registry spec owner): civitai/civitai-registry#57.
- **Writes as a divergence from portable-data** (the portable-data owner): portable-data writes are
  signed ops posted to the namespace's node (`POST <node>/write`, its README); Civitai writes with
  block tokens, unsigned. Raised as J2 against JustMaier/portable-data#2.
- **Private data in the registry under auth** (the registry spec owner): answered in favor on
  civitai-registry#49; the per-user stream design the reads use is the answer to its Q2.
- **The relay stall** (the registry spec owner): civitai-registry#50. Not on the write path, which
  has no relay, but it bounds what the read-after-write contract can promise through a gateway.
- **Refusing a subscriber with an explicit error instead of an empty snapshot** (the registry spec
  owner): civitai/civitai-registry#56. Needed before the read fallback can be removed.
