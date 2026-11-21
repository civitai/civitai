# app-data-go: design

**Status:** scaffold for review (P3 slice S5). Not deployed. Not to merge before the registry
adapter's private streams (S2, #9758) merge, and not to deploy before the prerequisites below. The
App Block token path (the hub's S4 block exchange) is built and **dark**: `APP_DATA_BLOCK_EXCHANGE`
defaults off, and the hub refuses every block exchange until its caller allowlist names this service
("Block tokens" below).

One shared service that serves app clients their users' **private** app data read through the
registry. Browsers never subscribe to the registry themselves: an app calls this service with the
hub token it holds for the signed-in user. The service then:

- exchanges that token at the hub as the registry adapter's **relay**, with its own client;
- reads the user's stream on the adapter with the exchanged token.

This follows the decision on civitai/civitai-registry#49, option (a). Each active user gets one
lazy, short-lived stream, opened with a token derived from **that user's** token, so the origin (the
adapter's private feed, `src/server/registry-adapter/private-feed.ts`) stays the only judge of what
the user may read. This service decides no access of its own.

## The read

```
GET /v1/apps/{slug}/collections/{collection}/records[?major=N]
Authorization: Bearer <the app's hub access token for the user>
```

1. Validate `slug`, `collection` and `major`, and build the collection's schema URN,
   `urn:schema:apps.civitai.com:<slug>/<collection>@v<major>` (`internal/urn`, pinned to the adapter's
   `registryUrn` by golden vectors).
2. If the registry path is on and the token is one the hub can exchange (below), read the token's
   stream for that schema (`internal/session`). A read:

   - opens the stream if none is open: exchange, then subscribe;
   - waits for `Live` for at most `LIVE_WAIT_MS`;
   - answers from the stream's cache. A stream answers only once it has sent `Live` (the spec's
     Consumers rule 2: `Live` means the snapshot is complete).

   The stream then stays open, so later reads within the idle TTL are answered from memory, and
   changes (revocations included) keep arriving.

3. Otherwise, or when the stream cannot answer (the fallback reasons in `internal/metrics`), the
   service reads the site's document-store REST list with the same token (`internal/rest`):
   `GET /api/v1/blocks/storage/<collection>?from=<slug>`. A site refusal is passed on as the site
   sent it.

The whole read is bounded by `REQUEST_DEADLINE_MS`. `LIVE_WAIT_MS < REQUEST_DEADLINE_MS` is
enforced at start, so the fallback always has time.

**The slug names the source app, always, on both paths.** Whether the read is of the app's own
collection or of another app's collection the user granted is never the client's to say:

- on the registry path, the adapter decides it from the token (`own` or `grant`, by
  `decideCollectionRead`);
- on REST, the site decides it from `from=<slug>`.

So a REST answer can never be one app's data under another app's slug. An earlier draft sent `from`
only when the client asked for an import, and the site then read the token's own app whatever the
slug said.

**An empty stream is not trusted.** The origin answers a token it refuses with an empty snapshot and
`Live`, exactly as it answers a user who holds nothing (S2's "a refused subscriber learns nothing").
Only REST can tell the two apart, so an empty stream answer goes to REST (`reason="empty"`). This is
also what makes a fully revoked grant answer the site's refusal rather than an empty list.

**Only private collections are in contract.** The private feed serves only collections declared
`private`; a shared collection's schema is served by the adapter's public feed, which answers
something else than the REST list. The service tells the two apart by the cursor of the stream's
`Live`. The adapter wraps every cursor it sends as `b1.<24 hex binding>.<inner>` (`subscription.ts`
`bindCursor`, `BOUND_CURSOR_RE`); the service unwraps exactly that grammar (`PrivateFeedCursor`), and
then:

- the private feed's inner cursors start with `p1.` (`PrivateCursorPrefix`);
- the public document feed's start with `f1.` (`doc-feed.ts`);
- a cursor outside the `b1.` grammar, a bare `p1.` included, is not private.

A stream whose `Live` is not the private feed's is closed unread, its key is left to REST for 15
minutes (`not_private`), and the read is answered by REST. This reads the adapter's cursors
directly, which is sound only because no relay sits between the two (a relay composes cursors of its
own).

## Tokens: this service is the adapter's relay

Decided by the operator after the round-0 audit: app-data-go has its own confidential hub client,
listed as a relay of the adapter's exchange resource and in `REGISTRY_ADAPTER_PRIVATE_RELAYS`. It
reads the adapter directly, not through `registry-exp`. Read against the hub's exchange
(`apps/auth/src/lib/server/oauth/user-exchange.ts`):

- **The subject token must be one of the hub's original access tokens** (step 5 looks it up among
  them by hash). A token without the hub's access-token prefix (`civitai_`) is therefore never sent
  to the user exchange: an App Block token goes to the hub's block exchange when
  `APP_DATA_BLOCK_EXCHANGE` is on ("Block tokens" below), and any other token, or a block token with
  the flag off, goes straight to REST (`token_not_exchangeable`).
- **The caller is a relay the resource lists** (step 4 and step 7). The exchanged token names the
  user in `sub`, the app the user's token was issued to in `client_id`, and this service in
  `act.sub`. That is what the adapter's gate 3 checks, and what its predicate judges.
- **An exchanged token cannot be exchanged again.** So this must be the only hop: the adapter is read
  directly.
- **The user's own token goes to two places only:** the hub's exchange endpoint and the site's REST
  read, which already takes it. It never reaches the adapter. This is the auth extension's Relays
  rule 1: a relay never passes a consumer's token on; it exchanges it for one whose resource is the
  upstream. The tests' fake adapter accepts only tokens the fake hub issued and fails any test that
  shows it another.
- **A refused exchange** (expired or revoked subject token, an app or user the resource does not
  admit) opens no stream: the read goes to REST (`exchange_refused`), whose answer is the site's.
  The key then cools down for 30 s.

**Least privilege: every exchange asks for exactly `AppDataRead`** (`exchange.Scope`, not
configurable), all a private stream reads (the adapter's gate 4). Unasked, the hub would issue the
whole ceiling. The hub parses `scope` as space-separated scope names (`scope.ts`
`parseScopeRequest`). The ceiling is the user's token's scope (the consent the user gave the app)
within the resource's and the app's allowed scopes (`token-exchange.ts` `exchangeScopeCeiling`). A
request outside that ceiling is refused (`invalid_scope`), never silently narrowed, so a user who
never granted the app `AppDataRead` gets a refused exchange, and the read goes to REST. The tests'
fake hub issues the whole ceiling to a request naming no scope, and the fake adapter fails any test
shown a token wider than `AppDataRead` (`TestTheExchangedTokenHoldsOnlyAppDataRead`).

Neither the exchange client nor the REST client follows a redirect: the `3xx` is the answer (an
exchange failure, a `502` from REST). A followed `307`/`308` would re-send the request body (the
user's token in the exchange form) and, to the same host, its `Authorization`, wherever `Location`
points.

The client secret is read from a file (`APP_DATA_CLIENT_SECRET_FILE`, preferred) or the environment,
never both, and no error, log or metric carries it or any token.

## Block tokens (`APP_DATA_BLOCK_EXCHANGE`)

An app running as an App Block holds a block token (the site-signed RS256 JWT), not a hub access
token. The hub's block exchange (`apps/auth/src/lib/server/oauth/block-exchange.ts`, S4) turns one
into the same kind of token the user exchange issues: an ES256 `at+jwt` with `sub` the viewer,
`client_id` the block's app, `act.sub` this service, scope `AppDataRead`, and
`exp = min(block token exp, now + 15 min)`. The adapter's private feed accepts it exactly as it does
a user-exchange token.

**The flag.** `APP_DATA_BLOCK_EXCHANGE` (`true`/`1` on; unset, `false` or `0` off; default off;
anything else fails the start, as does turning it on without the registry path). **Off, nothing
changes:** a block token reads REST (`token_not_exchangeable`) and is never sent to the hub, and the
streams' exchange is the user exchange itself (`exchange.Route` with no cache).

**On,** a token is routed by its shape (`exchange.KindOf`), never decoded or trusted here: the hub's
prefix is a hub token; three non-empty base64url segments is a block token, sent to the block
exchange (`subject_token_type=urn:civitai:token-type:block-token`, scope `AppDataRead`, the same relay
client and resource as the user exchange); anything else reads REST. The hub alone decides whether a
token is a block token it honours.

**Once per block token.** The hub claims each block token's `jti` and refuses a second exchange of it
as a replay, so `exchange.BlockCache` sits in front of the block exchange:

- **Issued:** the token is handed to every stream of that block token (one per collection read)
  until it expires; concurrent opens share one call.
- **Refused** (`400`/`401`): remembered; the hub is not asked again for that block token.
- **Failed** (the hub unreachable, a `5xx`, a `429`, a timeout): forgotten, so a later read may try
  again after the stream cooldown. The hub issued nothing, and gives back a claim it made (including
  one whose replay-store write timed out). If this service timed out after the hub did issue, the
  retry is refused as a replay and remembered: that block token reads REST.
- Entries are keyed by SHA-256 of the whole token, never by its `jti`: a token that merely reuses
  another's `jti` can never be handed the other's exchanged token. An entry is forgotten 16 minutes
  after its exchange (no exchange of a block token that old could succeed); at most 10,000 are held,
  and past that a new block token reads REST (`full`).

**Expiry.** The answer's life is held to 15 minutes whatever `expires_in` says. A stream closes 30 s
before its token expires, as for a hub token, and a cached token is not handed to a new stream inside
that margin (`spent`): the block token's one exchange is used up, so its next read goes to REST,
where the site answers with the block token itself.

**No revocation re-check.** A live stream re-checks a hub token every 2 minutes by exchanging it
again. For a block token that would be a replay, so the re-check gets the cached token back and the
stream keeps serving. This matches the hub, which reads no revocation state for a block exchange: a
block token's stream lives at most until its exchanged token expires, at most 15 minutes. The
adapter's own re-check of the user (ban, delete) still applies.

**Fallback.** Every refusal or failure reads REST exactly as a hub token's does (`exchange_refused`,
`failed`, `cooling_down`). Each block exchange is counted in
`app_data_block_exchanges_total{outcome,error}` (`issued`, `reused`, `refused`, `remembered`,
`failed`, `spent`, `full`; `error` is the hub's OAuth code for `refused` and `remembered`, else
`none`), and every outcome but `issued` and `reused` is logged with that code. Neither carries a
token, user or app.

**To turn it on** (none of it is in this repo): the hub needs the site's block-token public keys and
this service's client id in its block-exchange caller allowlist (an approval for the registry owner),
this service's client must already be a relay of the adapter's exchange resource, and the block's app
must be listed for that resource and allowed `AppDataRead`; then set `APP_DATA_BLOCK_EXCHANGE=true`
here.

## Token lifetime: a stream is reopened at its token's expiry

The hub caps an exchanged token at 15 minutes (`EXCHANGED_TOKEN_MAX_TTL`), and the adapter ends any
stream whose token expired (`invalid_token`, `auth.ts`). A token cannot be swapped on an open
stream. **Chosen: close the stream `30 s` before its token expires** (`reason="expiry"`, no
cooldown); the next read exchanges again and opens a fresh snapshot.

The alternative was to re-exchange ahead of expiry and resume the new subscription from the old
one's cursor, keeping the cache. That would work in principle: the cursor is bound to the token's
subject (user and client), which a re-exchange does not change. But it is a second code path:

- cursor tracking;
- a resume whose first poll must deliver every `Delete` missed (its own tests);
- a window with two subscriptions open, so twice the slots for that user.

All of that saves one snapshot of one user's collection (at most `MAX_RECORDS_PER_STREAM` records)
per active user per ~14.5 minutes. The cost of reopening is one exchange plus one snapshot for the
first read after expiry, within `LIVE_WAIT_MS` or answered by REST.

**Max age.** `STREAM_MAX_AGE_MS` defaults to 14 minutes and is refused above 15, so no setting can
keep a stream past its exchanged token. The expiry close is the one that normally fires.

**A stream never outlives its user's token either: revocation is bounded at 2 minutes.** The
exchanged token stays valid when the user's own hub token is revoked (signed out, the app's tokens
revoked, the user banned), and the adapter's re-check of it may come later. So a live stream
re-checks the user's token on the read path:

- a read that finds the last check older than 2 minutes exchanges the user's token again before it
  is answered (one read checks; reads arriving meanwhile are answered within the previous window);
- a **refusal** (`400`/`401`: the hub no longer exchanges that token) closes the stream, drops its
  cache and answers the read from REST (`reason="revoked"`), whose answer is the site's;
- a **failure** (the hub unreachable, a `5xx`, a timeout) keeps serving, and the next check is
  another 2 minutes later. A hub outage is not evidence of a revocation; treating it as one would
  turn every outage into a REST surge, and retrying on every read would hammer a hub that is down;
- with no read, nothing is checked: the cache is only ever served to a read, and every read is
  checked within the bound.

So a revoked user token is served from the cache for at most 2 minutes after its revocation (plus
one exchange's time), only to reads that hold that same token. Each check is one exchange per live
stream per 2 minutes of use; the token it returns is discarded.

## Isolation

A stream and its cache are keyed by **SHA-256(the user's token) + schema**. Nothing decodes a token
or knows whose it is, so a record received on one token's stream can only be read back with the same
token. Two tokens of the same user are two streams (the auth extension's Relays rule 2: an
authorized stream belongs to one consumer). Responses are `Cache-Control: private, no-store` and
`Vary: Authorization`. Metrics never carry a token, user, app or collection.

Tests prove it with pairwise-distinct fixtures (`TestRecordsNeverCrossFromOneTokenToAnother`,
`TestTwoUsersNeverSeeEachOthersRecords`), interleaved and concurrent, plus a user who holds nothing.

## Stream lifecycle and caps

| Setting                  | Default | Meaning                                                              |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `MAX_STREAMS`            | 100     | adapter streams open in the process                                  |
| `MAX_STREAMS_PER_TOKEN`  | 4       | streams one token holds (one per collection it reads)                |
| `STREAM_IDLE_TTL_MS`     | 300000  | a stream no read used for this long is closed                        |
| `STREAM_MAX_AGE_MS`      | 840000  | a stream is closed this long after it opened (at most 15 min)        |
| (fixed)                  | 30 s    | a stream is closed this long before its exchanged token expires      |
| `LIVE_WAIT_MS`           | 1500    | how long a read waits for a new stream's `Live`                      |
| `REQUEST_DEADLINE_MS`    | 4000    | one read, REST included                                              |
| `MAX_RECORDS_PER_STREAM` | 1000    | a stream whose cache outgrows this is closed; reads go to REST       |
| `MAX_BYTES_PER_STREAM`   | 2 MiB   | likewise, by approximate size; caches hold at most streams × this    |
| `REST_MAX_INFLIGHT`      | 64      | concurrent REST reads; over it a read answers 503 with `Retry-After` |

A read that would open a stream over either cap opens nothing and reads REST (`capacity`,
`token_capacity`). A stream that failed is not reopened for 30 s (`cooling_down`), so a broken
adapter or hub is not asked again on every read. A stream that ended, failed or outgrew its bounds
drops its cache with it: nothing is served from a stream that stopped following.

## Stream budget against the adapter's caps

The adapter caps open subscriptions in total, per client address and per token subject
(`limits.ts`; code defaults 2000 / 100 / 100, overridable by env). The arithmetic below uses the
caps the operator gave for this rollout: **500 in total, 250 per address, 50 per token**.

**One adapter stream per stream here.** With no relay in between, each stream this service holds
is exactly one adapter subscription. An authorized stream is never shared (Relays rule 2).

- **Per address (250):** this service's pods are the only callers from their addresses, so the cap
  binds per replica: `MAX_STREAMS` (100) leaves 150 of headroom.
- **In total (500):** shared with every other subscriber of the adapter (relays, gateways, indexes).
  `MAX_STREAMS` × replicas must stay under 500 less those. Two replicas at the default take 200.
- **Per token subject (50):** the subject is (user, app), and this service opens at most
  `MAX_STREAMS_PER_TOKEN` (4) per token, so it does not bind.
- **How many are open:** by Little's law, open ≈ (new active (user, collection) pairs per second)
  × (time each stays open). Time open is the session plus the idle TTL, capped at about 14.5
  minutes by the token. At 1 new pair/s with short sessions that is about 300 open, over one
  replica's cap. Past the cap reads go to REST, which is correct, only slower; lowering the idle TTL
  is the main lever.
- **Exchanges:** one per stream opened, so at most one per (user, collection) per ~14.5 minutes while
  active, plus one per reopen after a close. They count against this client's own rate limit at the
  hub.
- **Load on the adapter:** each private stream re-runs the predicate and re-reads one user's
  collection on every adapter poll (S2: about 5 queries per poll, default 60 s). 100 streams is about
  8 queries/s.

## No relay stall

Reading the adapter directly removes the relay stall of civitai/civitai-registry#50 (one unreachable
upstream behind a relay holding back every stream's `Live`). The live-wait deadline stays, as a guard
against a slow snapshot:

- a read waits at most `LIVE_WAIT_MS`, then reads REST (`not_live`);
- a stream that has made one read give up is **stalled**: later reads go to REST at once (`stalled`);
- a stall does not count as use, so a stalled stream closes at the idle TTL;
- a stream that reaches `Live` later serves normally;
- `REST_MAX_INFLIGHT` bounds the REST load this shifts onto the site.

## Revocation

Any of these makes the adapter's next poll (S2) send a `Delete` for each record the stream held, and
the cache drops them:

- a grant revoked;
- the import scope withdrawn;
- the app unapproved;
- the user no longer allowed to run apps.

The tests are `TestADeleteRemovesTheRecordFromTheCache` and
`TestARevokedGrantLeavesTheCacheAndTheSiteAnswersTheRefusal`. An upsert without a body is a delete
too (the spec's Validity rule 2). A change the cache cannot apply (a malformed upsert, delete or
`Live`) ends the stream rather than risk serving a record that should have left.

A revoked user token is served for at most 2 minutes ("Token lifetime" above). A revoked grant's
lag is the adapter's poll plus the time to the next read. REST reads see a revocation at once.

## Depends on site changes not in this PR

- **An app's own collection on REST.** Hub tokens may import on REST now (#9783): an import is judged
  by `decideCollectionRead`, the predicate the private feed runs. Every fallback read names its source
  as `from=<slug>`, so a read of the token's OWN app's collection needs the storage route to treat a
  `from` naming the token's own app as an own read; today it refuses it (`import_not_declared`: no app declares an import of itself).
  civitai/civitai#9800 makes that change, for every token kind; the `from` this service sends is the
  blockId (the URN slug segment), which is what #9800 matches. Until it merges, an own-collection
  read falls back to that refusal, and only the registry path serves it. Do not deploy before #9800.
- **Record names (Q2).** A stream names a record by its record core URN (`…/<record_id>`), the REST
  list by its key, and an app cannot match the two. The REST list should expose `recordId`: the
  store reads it (`doc-store.ts`), but `presentDocs` in `doc-store-api.ts` does not return it.

## Before merge

- S2 (#9758) merged, and this branch rebased onto it.
- `PrivateCursorPrefix` pinned to `private-feed.ts` by a golden vector, as `internal/urn` is to
  `urn.ts`. It can only be pinned once that file is on `main`.

## Not built

- Resuming a stream from its cursor (see "Token lifetime").
- A block-token stream outliving its block token's one exchange (see "Block tokens": the next read
  is REST's).
- Any write path (P3b), the app SDK side (P4), overlays.
- Deploy manifests and the image build.
- A true per-user cap: only per token, which is per (user, app).

## Defaults

The canary keeps the defaults above (operator, 2026-11-20): 100 streams per replica, 5-minute idle
TTL, 14-minute max age, 1.5 s live wait.
