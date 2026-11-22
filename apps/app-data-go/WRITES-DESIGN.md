# app-data-go: the writes service (P3b), design

**Status:** proposal, nothing built. This follows the reads in [DESIGN.md](DESIGN.md), which lists
"Any write path (P3b)" under "Not built" (`DESIGN.md:568`). Direction from the operator
(2026-11-19): the complete app platform runs via the registry; writes go through a registered write
service, scoped as a follow-up after reads; everything ships on the experimental registry gateway
(`registry-exp`) first. Reads are shadowing now (DESIGN.md, "P4: the site's shadow read").

This document is about the decisions. Each section states the facts the choice rests on, with
citations, then the options and a recommendation. The decisions the operator must make are
collected under "Decisions" at the end.

## What is fixed before we start

These are not open, and the design builds on them.

1. **The registry protocol has no write.** It has one call, `Subscribe`, and only an entity's
   origin changes it (civitai-registry `spec/registry.md:3`, `:50-51`). Its design article puts writes
   at the source: "An entity never changes through a registry" (`docs/articles/design.md:311`), and
   the app-with-forks scenario says a user writes to app storage, and the change reaches the registry
   through the adapter (`docs/examples/scenarios/app-with-forks.md:45`). No registry issue proposes a
   write verb. So "writes through the registry" means a write **service discovered through the
   registry**, never a write carried by a registry.
2. **The App Storage document store is the one writer today.** Every write is one transaction in
   `doc-store.ts` (`src/server/services/apps/doc-store.ts:2211-2294`): lock the row, write, sync the
   index rows, charge `usage_app` (which hands out the next `seq`), charge `usage_user`, stamp the
   `seq`. A delete writes a tombstone with its `seq`. The `seq` is handed out under the quota row's
   lock, so per (app, namespace) `seq` order is commit order, "which is what a future change-feed
   poller needs" (`doc-store.ts:104-106`).
3. **The registry adapter learns about writes only by polling the store.** There is no outbox,
   trigger or `NOTIFY`. The shared feed reads `doc` and `doc_tomb` rows past its `seq` position
   (`doc-store.ts:976-1026`); the private feed re-reads one user's keyset of `(key, version,
   record_id)` and diffs it (`doc-store.ts:1033-1045`). Both run every
   `REGISTRY_ADAPTER_POLL_SECONDS`, default 60 s (`src/server/registry-adapter/main.ts:144`). So any
   write that commits through `doc-store.ts` reaches the registry with no further work, within one
   poll.
4. **The write path's gates live in the site's storage handler**, in this order
   (`src/server/services/apps/doc-store-api.ts:1215-1300`): a signed-in viewer, the collection's
   write policy, the publish scope for a shared create or put, the body parse, the collection schema
   (`validateDocAgainstCollectionSchema`, again inside the store), owned model versions, the
   permission hook (`gateHook`, `doc-store-hook.ts`, calling the storage-hook-runner,
   `apps/storage-hook-runner/README.md:11-60`), the trust gate for shared writes
   (`block-write-trust.service.ts`), the write budget and rate buckets
   (`src/server/utils/shared-storage-rate-limit.ts:161-167`, `:277`), the moderation scan, then the
   store. The route is `withBlockScope` with `requiredScope: 'apps:storage'`
   (`src/pages/api/v1/blocks/storage/[[...path]].ts:29-36`).
5. **The hub has no write scope.** `AppDataRead` is bit 32 (`packages/civitai-auth/src/token-scope.ts:115`);
   the block exchange issues exactly that (`apps/auth/src/lib/server/oauth/block-exchange.ts:97`), and
   the private feed requires it (`src/server/registry-adapter/private-feed.ts:103`). There is no
   `AppDataWrite`.

## The write API and where it lives

**The shape.** The same verbs and bodies as the store's REST surface, under this service's existing
path, so an SDK swaps the base URL and nothing else:

```
POST   /v1/apps/{slug}/collections/{collection}/records            {data}            create
PUT    /v1/apps/{slug}/collections/{collection}/records/{key}      {data, ifVersion?} put
DELETE /v1/apps/{slug}/collections/{collection}/records/{key}[?ifVersion=N]           delete
PATCH  /v1/apps/{slug}/collections/{collection}/records/{key}      one of $inc/$mark/$unmark
Authorization: Bearer <the app's token for the user>
→ the store's answer, as the store sent it (status, body, error codes)
```

The REST surface it mirrors is `doc-store-api.ts:14-22`: optimistic concurrency by an integer
`ifVersion` (`0` = must not exist), `409 version_conflict` with `currentVersion`
(`doc-store.ts:2221-2237`); 64 KiB documents; the key and collection grammars of
`doc-store.types.ts:151-170`. `_publish`/`_unpublish` and the deprecated counter and mark routes are
not mirrored (see "What v1 covers").

**Where the write is executed.** Three places it could live:

| | A. app-data-go forwards to the site's store (recommended) | B. a separate deployment of the site's storage handler | C. the site's REST route is the registered service |
|---|---|---|---|
| What runs the write | the site's `createStorageHandler`, unchanged | the same TypeScript module, deployed apart from the site (as the registry adapter is) | the site, unchanged |
| New code | write routes here; a forward client beside `internal/rest`; the read-your-writes rule | a new service wrapping `createStorageHandler`, with every dependency it reads (main DB for approvals, the store's DB, Redis buckets, Flipt, the moderation scanner, the hook runner) | a service entity naming the existing route; nothing else |
| One endpoint for an app's reads and writes | yes | no (two services) | no |
| Read-your-writes | this service sees each write, so it can hold its own streams honest (below) | needs a channel to app-data-go | none |
| Gates duplicated | none | none (same module), but a second copy of its environment | none |
| Load off the site | no | yes | no |
| "Model-benchmarking writes only through it" is a real test | yes: measurable at the site (below) | yes | no: it is true today, so it proves nothing |

**Recommendation: A for v1.** It is the smallest change that makes the write service a real seam:
one service per app for both directions, the store's code stays the only writer, and this service
can keep its own read path consistent with the writes it carried. It decides no access of its own,
the rule the reads already follow (`DESIGN.md:17-18`). B is the later step if the site's load or its
deploy cadence becomes the reason; A's API is B's, so apps do not change again. C is option "writes
at the source" with discovery only, which the protocol already allows; it does not need this design.

## Authn, authz and the write token

**v1: the user's own token goes to the site, as the REST read fallback already sends it.** The reads
send the user's token to two places only, the hub's exchange and the site's REST read
(`DESIGN.md:98-101`). A forwarded write adds the site's REST write as a third, the same host and the
same trust: the site is the token's audience already. Then:

- the site does all authorization exactly as for a direct call: token kind and namespace
  (`resolveStorageAccess`, `doc-store-access.ts:141-215`), `apps:storage`, `apps:storage:publish`
  for a shared create or put, consent (an unreadable marker is `503 consent_unavailable`), the
  one-hop import write through `?from=` (`resolveImportAccess`, `doc-store-access.ts:288-367`;
  a `read` import is `403`);
- this service checks shape only (slug, collection, key grammar, body size) so a malformed request
  never reaches the site, and routes by token shape exactly as reads do (`exchange.KindOf`); it never
  decodes a token to decide anything;
- the rate buckets stay per (app, principal) (`shared-storage-rate-limit.ts:139-190`), because the
  principal is still the user's token: going through this service gives no app a second budget.

**What a write token would have to carry, when the writer is no longer the site.** If the write
ever executes somewhere that is not the token's audience (option B on another origin, or a
non-Civitai writer), the user's token must not travel; it must be exchanged, as the reads do. That
token needs:

- a new hub scope, `AppDataWrite` (bit 33), opt-in, excluded from `Full`, a user scope so an
  exchange resource may list it (the rules `token-scope.ts:109-116` gives `AppsRead` and
  `AppDataRead`);
- `sub` the user, `client_id` the app, `act.sub` the writer (the reads' shape, `DESIGN.md:93-95`);
- for an App Block token, the four binding claims the block exchange already writes
  (`civitai_token_kind`, `civitai_app_block_id`, `civitai_block_instance_id`,
  `civitai_max_browsing_level`; `DESIGN.md:131-134`), so the writer refuses a write from an
  uninstalled block as `withBlockScope` does;
- a separate exchange from the read's: a block token can be exchanged once (`DESIGN.md:169`), so
  `AppDataRead AppDataWrite` would be asked in one exchange and narrowed per use, or the block
  exchange would issue both. This is the reason not to do it in v1: the one-exchange rule makes the
  write token a change to the hub, the block exchange and the consent screen at once.

**Recommendation:** no new scope in v1. Record `AppDataWrite` as the shape for when the writer moves.

**Telling a forwarded write from a direct one.** The site must count writes by path to measure the
cutover (below), and a client header can be forged. The forward carries a header signed by this
service (HMAC over the method, path, a body digest and a timestamp, the storage-hook-runner's scheme,
`apps/storage-hook-runner/README.md:15-20`), verified by the site. It is a **label, never an
authorization**: a bad or missing signature counts the write as direct and changes nothing else.

## Source of truth and consistency

The registry is not a store (fixed point 1), so "dual-write" can only mean two stores. The options:

| | Single writer: the store (recommended) | Dual-write: the store plus a second store this service owns | This service is the writer and writes the store's DB itself |
|---|---|---|---|
| Truth | `appdata.doc` | two, with no reconciler | `appdata.doc`, but written by two codebases |
| Consistency | per (app, namespace) linearizable: one transaction, `ifVersion`, `seq` = commit order | none across the two | as today only if the Go writer re-implements the quota, `seq`, tombstone, index and RLS discipline exactly |
| Rollback | stop routing; nothing to copy back | reconcile two stores | stop routing, if the two writers never disagreed |
| Verdict | | rejected | rejected: the gates in fixed point 4 would exist twice, in two languages |

**Recommendation: single writer.** Every write commits through `doc-store.ts`. This service holds no
data but its read caches. The consistency model a client sees is the store's: a write is acknowledged
after commit; concurrent writes to one key are ordered by `version` and refused by `ifVersion`.

**Retries.** This service never retries a forwarded write. A `create` without a key gets a
server-picked key (`doc-store.ts:2348-2359`), so a retried create after a lost answer writes twice.
A forward that times out answers `504` with `outcome: unknown`, and the client re-reads before it
writes again (an `ifVersion` put is then safe to resend). This is the one behavior an app could
notice; the REST route has the same ambiguity on a dropped connection today, only less often.

## How a write reaches the registry, and read-your-writes

The path is unchanged: the store commits, the adapter's next poll sees the change (fixed point 3),
and every stream holding that record gets an `Upsert` or `Delete`. The lag is up to one poll
(default 60 s) plus delivery.

That breaks read-your-writes for this service's own reads: an app that writes a record and lists
its collection within the poll window would get the stream's stale cache. Options:

| | A. Recent-write window reads REST (recommended for v1) | B. Apply the write to the stream's cache | C. Nudge the adapter |
|---|---|---|---|
| Rule | after this service carries a write on token T to collection C, reads of C on T answer from REST until `POLL_SECONDS + 15 s` has passed since the last such write (fallback reason `recent_write`) | after the store's `2xx`, upsert or delete the record in T's stream cache, marked provisional; the next poll's snapshot replaces it | the site or this service asks the adapter to poll that user's stream now |
| Correct by construction | yes: REST reads the store | only if a provisional entry can be told apart from a later poll that predates it; the stream's `rev` is a digest (`DESIGN.md:463-464`), not the store's `version` | yes, still up to one poll's delivery |
| Cost | REST load while an app is actively writing | a second cache code path and its tests | a new adapter endpoint and an auth story for it |
| Other tokens of the same user | still up to one poll | still up to one poll | fixed |

**Recommendation: A**, counted (`app_data_reads_total{source="rest",reason="recent_write"}`), so the
REST share it causes is measured before anything more clever is built. B becomes sound once the
private feed carries the store's `version` beside each record's key (it already reads it,
`doc-store.ts:1033`): then a provisional entry is replaced only by a poll whose version is at least
the written one. C belongs with the adapter's own roadmap.

**What a client may assume, stated as the contract:** a write acknowledged by this service is in the
store; a read through this service on the same token after the acknowledgement returns it; a read on
any other token or through the registry directly returns it within one adapter poll.

## Hooks, charging, quotas, validation and moderation: parity with REST

Option A gets parity by construction: the forward lands in `createStorageHandler`, so each gate runs
in the same order on the same inputs. What must still be checked, per gate:

| Gate | Where | Parity under A | What to watch |
|---|---|---|---|
| Collection schema | `doc-store-api.ts:1236`, again in the store | same code | none |
| Permission hooks | `gateHook`, `doc-store-hook.ts`; the runner (#8126 merged, the runner deployed with hooks off) | same code; fail-closed `503 hook_unavailable` passes through | the forward's timeout must exceed the hook's client timeout (timeout + 450 ms, `doc-store-hook.ts:106-113`, at most ~950 ms) |
| Rate buckets and shared-write budget | `shared-storage-rate-limit.ts:161-167`, `:277` | same principal, so the same buckets | none; a second budget would be a bug |
| Change-only shared-write charging | flag `app-blocks-storage-unchanged-writes-free`, default off (`doc-store-api.ts:1302-1321`; #9166) | same code | shared collections are out of v1, so nothing yet |
| Buzz | none: the store charges no Buzz on writes (no Buzz call in `doc-store-api.ts` or `doc-store.ts`) | n/a | if a per-write charge is ever added, it lands in the store, so it applies to both paths |
| Quotas | conditional upserts on `usage_app` / `usage_user`, `413 quota_exceeded` (`doc-store.ts:2120-2161`) | same code | none |
| Moderation and content levels | shared writes only (`doc-store-api.ts:958-1064`; `doc-levels.ts`) | same code | out of v1 |
| Schema major stamp | `withSchemaMajor` (`doc-store-api.ts:825-833`) | same code | see "Schema versioning" |
| Audit and app attribution | the site's request labels (`requestAppLabel`) | the same token, so the same app | add `via` (below) |

The one thing A changes is **who sees the client's address**: the site sees this service's. Nothing
in the write path keys on the client address today; that has to stay true, and the forward must not
pass a client-supplied `X-Forwarded-For` on as if it were trusted.

## What v1 covers

**Private-collection `create`, `put` and `delete`, own app only.** That is what the first app needs:
model-benchmarking's lists are prefixed scans of its private collection (`DESIGN.md:434-435`), and
its writes are the SDK's key-value `set`/`delete`. Out of v1, each with its reason:

- shared collections: the trust gate, moderation and content levels, the store-card sync on delete
  (`doc-store-api.ts:1285-1294`), and a different registry feed; all would pass through under A, but
  none is exercised by the first app, so none would be verified;
- tallies (`PATCH`): shared-only in practice;
- `_publish`/`_unpublish`: batch, flag-gated per app, refused on hooked collections;
- import writes (`?from=`): need the import's own consent checks verified on this path first.

Each is a later, separate turn-on with its own shadow, not a code fork: the forward is generic, and
v1 refuses the rest at this service with `501 not_supported_here` so an app falls back to REST.

## Schema versioning (D2)

**What writes change: little.** A write is validated against the collection's current schema and
stamped with the current major, in the site (`withSchemaMajor`). The writes service sends no major
and cannot choose one, so it cannot write a body under a major it does not satisfy. Options for a
client that sends one:

| | A. Writes only at the current major (recommended) | B. Accept an older major and upcast | C. Accept and stamp the claimed major |
|---|---|---|---|
| Behavior | a request naming a major other than the current one is `409 stale_major`; none named, current | apply the forward step chain, then validate | store as sent |
| Needs | nothing | a production caller of `applyMajorChain` (`storage-schema-majors.ts:309`; only tests call it today) | the store to accept multi-major writes |
| REST parity | yes: REST validates against the current schema | no | no |

**What D2 is, and why it is not this service's to decide.** D2 is open question 2 of the registry's
migrations proposal: how a stream at major N serves a document written at N+1 ("Defaults and renames
reverse cleanly; removals don't", civitai-registry `proposals/migrations.md:62`). The proposal today
keeps one body per entity and drops a migrated body from the old major's stream as a `Delete`
(`proposals/migrations.md:53`). The candidate answers: reverse renames, keep defaults, validate
against the older schema and serve it under the same URN if valid (one URN, a body per major); serve
older majors through a translator under its own URN (`proposals/translators.md`); or let newer
writes leave the old stream. It is owned by the spec (Justin), and it decides what the **adapter's
streams** serve, not what a write stores.

**How writes make it bite sooner.** Today a breaking major is rare: a hold flag refuses a second
breaking approve on a held collection. Once an app's writes go through this service, a client still
running the old bundle after an approve writes through REST and this service alike, and is refused
by schema validation alike, so parity holds. The new exposure is only on the read side: every
document a new-version client writes leaves the old-major stream. The cutover app should therefore
not ship a breaking major during its 7-day window, and the window's metrics should show it did not.

## Migration plan

Each step has a closing condition and a way back. Everything on the experimental gateway first, as
the reads.

0. **Prerequisite: the reads are promoted.** The P4 shadow's gate (7 days of real-user comparisons
   under 0.1% mismatched, at least one non-empty compared list) is met, and S7 is promoted. A writes
   service on top of an unverified read path would make every read-your-writes failure ambiguous.
1. **Build, dark.** Write routes here behind `APP_DATA_WRITES` (default off: every write route is
   `404`); the forward client; the signed `via` header and the site's verification; the
   `recent_write` rule. Tests: a fake store that records exactly what was forwarded (token
   unchanged, body unchanged, no retry); a create whose answer is lost is answered `504
   outcome=unknown` and never re-sent; a read after a write on the same token reads REST; isolation
   (a write on token A never changes a read on token B, pairwise-distinct fixtures, as the reads'
   `TestTwoUsersNeverSeeEachOthersRecords`).
2. **Shadow: compare the service's own part, write nothing twice.** Because the store is the only
   writer, a shadow write cannot write twice. What can be compared before any app depends on the
   service is the service's own part: after the site answers a write for a shadowed app, it sends
   this service a dry run (`X-App-Data-Dry-Run: 1`: shape checks and token routing only, no forward),
   and compares the classes (accepted / refused-by-shape). Plus, after each such write, the
   **write-to-stream lag**: the time from the store's commit to the first read-only stream read that
   holds the new version, sampled. Closing: 7 days for model-benchmarking with zero class mismatches
   and a measured lag distribution (the number that sizes the `recent_write` window).
3. **Per-app cutover: model-benchmarking.** A per-app Flipt flag (`app-data-writes-via-service`,
   entity the app block id, as the read shadow's flag) tells the SDK to write through this service.
   This needs the service's public route and CORS for the app's origin, the same work P4's
   client-side serving needs, so it should land once for both. Closing (the stated one):
   **model-benchmarking writes only through the service for 7 days**, measured at the site as zero
   writes from that app's tokens without a valid `via` signature, with `app_data_writes_total`
   non-zero over the same days (the positive control: a zero direct count means nothing if no
   write went through the service either).
4. **General.** Per app, the same flag, the same 7-day closing. The REST write route stays: it is the
   fallback and the path every app not cut over uses. Removing it is a separate decision, after every
   app has passed step 3, and only once option B (or a successor) exists.

**Registration.** The service is announced to clients through the registry as a service entity for
the `apps.civitai.com` namespace, naming this route and its auth scheme, on the precedent of an
existing internal `service@v1` schema whose entities name a source's write endpoint. The adapter is
the origin for that namespace, so it publishes the entity. Until the SDK discovers the endpoint from
the registry, the flag in step 3 carries the URL; discovery is not on the cutover's critical path.

## Rollback

- **Per app, immediate:** turn the app's flag off. The SDK writes REST again. Nothing is copied back,
  because nothing was ever written anywhere else (single writer).
- **Everywhere:** `APP_DATA_WRITES=false`. Every write route answers `404`; an SDK that sees a `404`
  from the writes route falls back to REST once per session and stops trying.
- **The service down:** an app under the flag gets errors, not silent loss. Whether the SDK should
  fall back to REST on a `5xx` or unreachable service is a decision (below), because the fallback
  makes the closing condition harder to read.

## Metrics

On this service (no label carries a token, user, app, collection or key, as the reads'):

- `app_data_writes_total{op,outcome}`: `op` in `create|put|delete`; `outcome` the store's status
  class, `refused_here` (shape, `not_supported_here`), `unknown` (a lost answer), `unavailable`;
- `app_data_write_forward_seconds{op}`: forward latency;
- `app_data_reads_total{source="rest",reason="recent_write"}`: the read-your-writes cost.

On the site:

- `app_storage_writes_total{op,via}`: `via` in `service|direct`, by the signed header;
- the dry-run comparison during step 2, as the read shadow's `app_data_shadow_*` series;
- the write-to-stream lag histogram (step 2).

## Risks

1. **A second path to the store that a later change makes asymmetric.** Any gate added to the REST
   route must apply to forwarded writes. Under A it does, because the forward lands in the same
   handler. The guard is structural: a test that lists every writer of `appdata.doc` (today:
   `doc-store.ts` only) and fails if the set grows or shrinks, so a direct writer cannot be added
   quietly.
2. **Duplicate creates on a lost answer.** Mitigated by never retrying and by `outcome=unknown`; an
   app that wants exactly-once create should use `put` with `ifVersion: 0` and its own key.
3. **The `via` label forged or missing.** A label only: at worst the cutover's count is wrong. A
   forged label claims a write went through the service when it did not, which could close step 3
   early; the HMAC key held only by this service and the site is the defense.
4. **The site sees one client address for many users.** Nothing keys on it today; a test should pin
   that no write-path limit reads the client address.
5. **Read-your-writes across tokens.** Two tabs of one user are two tokens and two streams; the
   second sees the first's write after one poll. Documented in the contract; fixed only by option C.
6. **Load.** Under A every write is one extra in-cluster hop; the site's work is unchanged. The
   `recent_write` rule moves some reads back to REST; the metric above sizes it.

## Decisions

Each has options above; the recommendation is first.

1. **Where the write executes:** A (app-data-go forwards to the site's handler), B (a separate
   deployment of the handler), or C (register the site's REST route only).
2. **The write token in v1:** forward the user's token to the site (no new scope), or introduce
   `AppDataWrite` and an exchanged write token now.
3. **Read-your-writes:** the recent-write window reads REST, apply writes to the stream cache, or
   nudge the adapter.
4. **v1 scope:** private create/put/delete only, or include shared collections (and so moderation,
   trust and the store-card sync) in the first cutover.
5. **A schema major on a write:** current major only (`409 stale_major`), upcast, or stamp as sent.
6. **SDK behavior when the service is down, for a cut-over app:** fail the write (clean closing
   condition, lower availability), or fall back to REST and count it (higher availability, the
   7-day window resets on any fallback).
7. **Shadow step:** the dry-run comparison plus lag measurement in step 2, or skip straight to the
   cutover for model-benchmarking (its writes then are the comparison, with the flag as rollback).

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
