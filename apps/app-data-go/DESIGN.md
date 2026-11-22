# app-data-go: design

**Status:** P3 slice S5, built on the registry adapter's private streams (S2). Not to deploy before
the prerequisites below. The App Block token path (the hub's S4 block exchange) is built and **dark**: `APP_DATA_BLOCK_EXCHANGE`
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
`exp = min(block token exp, now + 15 min)`. It also carries the block token's binding, four claims
written together: `civitai_token_kind: "block-exchange"` (the marker), `civitai_app_block_id`,
`civitai_block_instance_id` and `civitai_max_browsing_level` (the block token's ceiling). The adapter's
private feed accepts it as it does a user-exchange token, and holds every poll of its streams to that
binding ("No wider than REST" below).

**The flag.** `APP_DATA_BLOCK_EXCHANGE` (`true`/`1` on; unset, `false` or `0` off; default off;
anything else fails the start, as does turning it on without the registry path). **Off, nothing
changes:** a block token reads REST (`token_not_exchangeable`) and is never sent to the hub, and the
router has no block cache, so a hub token is exchanged exactly as before.

**One decision.** `exchange.Router` alone decides which tokens are exchanged: the handler asks its
`Accepts` before opening a stream and the streams call its `Exchange`, so the two cannot disagree. A
block token never reaches the user exchange, the block exchange on or off.

**On,** a token is routed by its shape (`exchange.KindOf`), never decoded or trusted here: the hub's
prefix is a hub token; three non-empty base64url segments is a block token, sent to the block
exchange (`subject_token_type=urn:civitai:token-type:block-token`, scope `AppDataRead`, the same relay
client and resource as the user exchange); anything else reads REST.

**Verified here first.** Before a block token is sent to the hub, `exchange.BlockVerifier` checks it
as the hub's `verifyBlockTokenForExchange` does (`apps/auth/src/lib/server/oauth/block-token-verify.ts`,
itself the site's check): the RS256 signature against the site's published key for its `kid`,
`typ: JWT`, issuer, audience, expiry and not-before with 30 s of tolerance, the claim shapes, a
signed-in subject, no dev / review / private-run marker, and the 15-minute age cap. A token that fails
is refused here (refusal code `local`, remembered like a hub refusal) and never sent; its read goes to
REST. The hub still verifies every token it is sent.

- **Keys** are the site's block-token JWKS (`APP_DATA_BLOCK_JWKS_URL`, the site's
  `/api/v1/block-tokens/jwks`, unauthenticated; current and next key, so a rotation is two keys). A
  key is used only when its published `kid` is the site's derivation from its modulus. The set is
  fetched on first use, refreshed after 5 minutes, and fetched again when a token names an unknown
  `kid` (a rotation), at most once per 30 s; an unknown `kid` after a fresh fetch is refused, and one
  inside the 30 s is not checkable yet.
- **Fail closed.** With no usable key set (never fetched, or the last good fetch over an hour old),
  a block token is not checkable: it is not sent to the hub, not remembered, and its read goes to REST
  (`app_data_block_exchanges_total{outcome="unverifiable"}`).

**Once per block token.** The hub claims each block token's `jti` and refuses a second exchange of it
as a replay, so `exchange.BlockCache` sits in front of the block exchange:

- **Issued:** the token is handed to every stream of that block token (one per collection read)
  until it expires; concurrent opens share one call.
- **Refused** (`400`/`401`): remembered, apart from the issued tokens and only up to 1,000; the hub
  is not asked again for a remembered one. Any token of a block token's shape reaches the hub, so a
  flood of made-up tokens produces refusals: kept apart, they can never fill the issued tokens' room
  or lock a real block token out of this cache, and past the cap a refusal is simply not remembered
  (the hub is asked again and refuses again). A made-up token is refused here ("Verified here
  first"), so it never reaches the hub or spends this service's one exchange budget there, which its
  user exchanges share.
- **Failed** (the hub unreachable, a `5xx`, a `429`, a timeout): forgotten, so a later read may try
  again after the stream cooldown. The hub issued nothing, and gives back a claim it made (including
  one whose replay-store write timed out). If this service timed out after the hub did issue, the
  retry is refused as a replay and remembered: that block token reads REST.
- Entries are keyed by SHA-256 of the whole token, never by its `jti`: a token that merely reuses
  another's `jti` can never be handed the other's exchanged token. An entry is forgotten 16 minutes
  after its exchange (no exchange of a block token that old could succeed), at the next sweep (at
  most one scan a minute); at most 10,000 issued tokens are held, and past that a new block token
  reads REST (`full`, answered without a scan).

**Expiry.** The answer's life is held to 15 minutes whatever `expires_in` says. A stream closes 30 s
before its token expires, as for a hub token, and a cached token is not handed to a new stream inside
that margin (`spent`): the block token's one exchange is used up, so its next read goes to REST,
where the site answers with the block token itself.

**No revocation re-check here.** A live stream re-checks a hub token every 2 minutes by exchanging
it again. For a block token that would be a replay, so the re-check gets the cached token back and the
stream keeps serving. Revocation is the adapter's: its private feed re-checks the block token's
install, block and ceiling on every poll ("No wider than REST" below), and its own re-check of the
user (ban, delete) still applies. Nothing else outlives the exchanged token, at most 15 minutes.

**Fallback.** Every refusal or failure reads REST exactly as a hub token's does (`exchange_refused`,
`failed`, `cooling_down`). A spent block token and a full cache have their own fallback and close
reasons (`block_spent`, `block_cache_full`), not the registry's `error`; both still cool the key
down for 30 s. Each block exchange is counted in
`app_data_block_exchanges_total{outcome,error}` (`issued`, `reused`, `refused`, `remembered`,
`failed`, `spent`, `full`, `unverifiable`; `error` is the hub's OAuth code for `refused` and
`remembered`, or `local` for a token refused here, else `none`). Every outcome but `issued`, `reused`,
`unverifiable` and a `local` refusal is logged with that code (those are counted only, so a flood or a
JWKS outage is not a flood of log lines). Neither carries a token, user or app.

**No wider than REST.** The site's document store reads a block token's own block, holds mature
ratings to the token's ceiling, and refuses at once a token whose install was uninstalled, turned
off or whose publisher was banned (`withBlockScope`). The adapter's private feed holds a
block-exchange token's streams to the same three things on every poll
(`src/server/registry-adapter/private-feed.ts`), from the token's binding claims:

- **Ceiling.** A source app is read only when the viewer's own settings admit its rating AND the
  store's ceiling rule (`ratingAllowedForCeiling`, the function the store's import read uses) admits
  it for `civitai_max_browsing_level`: a mature rating (`r`, `x`, `xxx`) only under a ceiling with a
  mature bit. An SFW host's token streams no mature-rated app's records, its own app's or an import's.
- **Block.** The collection-read predicate (`decideCollectionRead`) is given
  `civitai_app_block_id`, and refuses unless that block is still its client's one approved block,
  by its own resolution (the source for an own read, the consumer for an import).
- **Install.** The install's revocation markers (`BlockRevocation.isRevoked`, the store's check) are
  read for `civitai_block_instance_id`; a revoked install is refused. Like the store's, a marker that
  cannot be read is not a revocation.

A refusal is a stream that holds nothing: the next poll (default 60 s) sends a `Delete` for every
record it held, and the cache drops them. The hub still refuses, when it exchanges, a block token
whose block is not its client's one approved block (defence in depth; the feed is authoritative per
poll), and one with no usable ceiling.

**Per resource: who may be sent a low ceiling.** Each exchange resource on the hub
(`OAUTH_EXCHANGE_RESOURCES`) declares whether it narrows by the binding claims:
`"narrowsBlockClaims": true`. Only a resource that declares it is sent a block-exchange token whose
ceiling leaves out R, X or XXX. Any other resource (undeclared is the default) is sent only a token
whose ceiling admits every mature rating, the rule before the claims existed, so a hub newer than the
adapter, or any other `AppDataRead` resource, can never read more than the block token would. A value
that is not `true` or `false` is a bad entry, and the hub then registers no resource at all. A token carrying some of the binding claims but not all four,
well-formed, is refused by the adapter (`invalid_token`); one carrying none is a user-exchange token
and is not narrowed (the viewer's own settings, as before).

**Who can use the registry path now:** with the adapter's resource declaring `narrowsBlockClaims`, any
signed-in viewer's block token with `apps:storage`, from any host, whose app passes the hub's other
checks: a token minted on an SFW host streams only SFW-rated apps' records, one minted on the
mature-capable host what the viewer's own settings admit. Without the declaration, only tokens minted
on the mature-capable host.

**Residual windows,** each bounded by the adapter's poll interval (default 60 s) rather than the
exchanged token's life:

- (a) **The approved block switches**, (b) **uninstalled or turned off**: cut on the next poll. REST
  refuses at once; the registry path may serve up to one poll longer.
- (c) **A Redis outage** reads no install marker, so a revoked install keeps streaming until its token
  expires (at most 15 minutes), exactly as REST serves it then (both fail open).

**To turn it on** (none of it is in this repo), in order:

1. Prerequisite: the hub and the adapter both run a release that writes and reads the binding claims
   (this one or later). No block-exchange token is minted before that.
2. The hub needs the site's block-token public keys and this service's client id in its
   block-exchange caller allowlist (an approval for the registry owner); this service's client must
   already be a relay of the adapter's exchange resource, and the block's app must be listed for that
   resource and allowed `AppDataRead`.
3. Here, set `APP_DATA_BLOCK_JWKS_URL` to the site's `/api/v1/block-tokens/jwks` and
   `APP_DATA_BLOCK_EXCHANGE=true`. Tokens with every mature rating in their ceiling now use the
   registry path.
4. Only once the adapter that narrows by the claims is live, declare `"narrowsBlockClaims": true` on
   the adapter's resource in the hub's `OAUTH_EXCHANGE_RESOURCES`: SFW-host tokens then use it too.
   Never declare it on a resource that does not narrow.

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
  8 queries/s. A block token's stream adds its install's revocation read (two or three cache GETs)
  per poll.

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
- the user no longer allowed to run apps;
- for a block token's stream: its block no longer its client's one approved block, or its install
  uninstalled, turned off or its publisher banned ("No wider than REST" above).

The tests are `TestADeleteRemovesTheRecordFromTheCache` and
`TestARevokedGrantLeavesTheCacheAndTheSiteAnswersTheRefusal`. An upsert without a body is a delete
too (the spec's Validity rule 2). A change the cache cannot apply (a malformed upsert, delete or
`Live`) ends the stream rather than risk serving a record that should have left.

A revoked user token is served for at most 2 minutes ("Token lifetime" above). A revoked grant's
lag is the adapter's poll plus the time to the next read. REST reads see a revocation at once.

## P4: the site's shadow read

The first caller is the site itself, in **shadow**: an App Block's App Storage list
(`GET /api/v1/blocks/storage/<collection>`, the block SDK's `storage.list`) is still answered by the
site's document store, and a sampled fraction of those lists is also read here, off the response
path, and compared. Nothing the app sees changes. Code: `src/server/services/apps/app-data-shadow.service.ts`,
called by the storage route (`doc-store-api.ts`) after it has sent its answer.

**Server-side, not in the browser.** Serving apps from here (a browser SDK calling this service) is a
later step, and it needs a public route. A shadow needs neither: the site already holds the block
token and the answer, and only a server can count and log the comparison. So the shadow call is
site → this service, in-cluster, with the request's own `Authorization` header, sent on unchanged.

**Registry only (`X-App-Data-Registry-Only: 1`).** This service's fallback is the very route that is
asking, so the shadow request asks for the registry's answer only: a read the registry cannot answer
is answered `200 {"source":"none","reason":<fallback reason>,"items":[]}` and REST is not read
(`app_data_reads_total{source="none",outcome="registry_only"}`, not a fallback). The header only ever
makes a read do less; the preflight does not allow it, so a browser cannot send it.

**Which lists are shadowed.** The app's own collection (no `from`, or `from` naming the app itself),
a `private` collection, the published namespace, an `app` or `hub` token with a signed-in viewer, and
no list parameter but `limit` and `keyPrefix` (no filter, sort, mark, author or cursor). A
`keyPrefix` is sent on, and this service filters the stream's records by it (below). The REST answer
must be the whole collection, or the whole prefix: a list with a next page is counted `incomplete`
and not asked (a paged list would need the site to read every page itself, which the shadow does not
do). The schema major is the collection's current one (`resolveSchemaMajor`), 1 when it has none.

Why `keyPrefix` matters: model-benchmarking, the first app, lists its private collection only through
a prefixed scan (the SDK kv `list({ prefix })`), so without it every one of its lists would be
`unsupported_input`.

**The gate,** in order, each before any work of the next:

1. `APP_DATA_SHADOW_URL` set (this service's base URL; unset: nothing happens);
2. a sample: `random() < APP_DATA_SHADOW_SAMPLE` (default `1`: every eligible list of an app the
   flag is on for; the flag is the ramp, the knob stays for load);
3. fewer than `APP_DATA_SHADOW_MAX_IN_FLIGHT` (default 4) shadow reads in flight in the process,
   else counted `saturated` and dropped;
4. the Flipt flag **`app-data-registry-shadow`**, a boolean evaluated **per app**: entity id the app
   block id (`apb_…`), context `{ blockId: <the app's slug> }`. Default off (absent, or Flipt
   unreachable). To start with model-benchmarking only: `enabled: false` with a rule whose segment
   matches its app block id (an `ENTITY_ID` constraint), or its slug (a `blockId` context
   constraint), returning `true`. Off for an app, nothing is asked and nothing is counted.

Each read is bounded by `APP_DATA_SHADOW_TIMEOUT_MS` (default 2000 ms, above this service's
`LIVE_WAIT_MS`), does not follow redirects, and never fails, delays or changes the REST answer: it
starts after the response is sent, and every failure is an outcome.

**What is compared.** Each record by its storage key, and its `data` canonicalised (sorted keys) and
hashed: a key on one side only (`rest_only`, `registry_only`), or on both with different data
(`data`). The keys match because the adapter's private feed now sends each record's key ("Private
records carry their key" below). When a registry record carries no key (an adapter that predates
it), the records are matched as a multiset of their data instead (`basis="data"`), which cannot
tell a changed record from a removed one plus an added one. Versions are not compared (a stream's
`rev` is a digest). An empty registry answer (`reason: empty`) agrees with an empty REST answer and
is a miss against a non-empty one, since this service cannot tell an empty stream from a refused
one.

**Telemetry** (on the site's `/api/metrics`; no label carries an app, collection, key, user or value):

- `app_data_shadow_requests_total{outcome}`: `compared`, `unsupported_input`, `incomplete`,
  `saturated`, `registry_miss`, `timeout`, `error`, `bad_response` (a `rest` answer counts here: a
  release of this service without registry-only);
- `app_data_shadow_registry_misses_total{reason}`: this service's fallback reasons (`unkeyed`
  included), `other` for any it adds later;
- `app_data_shadow_compared_total{result,basis}`: `match`/`mismatch`, by `key`/`data`;
- `app_data_shadow_compared_records_total` and `app_data_shadow_mismatched_records_total{kind}`
  (`rest_only`, `registry_only`, `data`).

A mismatch is logged (`app-data-shadow-mismatch`, at most 30 lines a minute per process) with the
app block id, the collection, the basis and the counts only: never a key or a value.

**Private records carry their key.** The adapter's private feed sends each record's storage key as
the entity's `key`, beside the body (`private-feed.ts`, `Entity.key` in `protocol.ts`). The body is
unchanged, still the document its schemas claim, so no collection schema changes (and private
collections' schemas are not published to registries anyway); the URN still names the `record_id`.
A private stream belongs to one user's token, so a key never reaches another user. The public feeds
carry no key. The HTTP binding sends it (an SSE upsert is the whole entity); the gRPC binding's
`Entity` message has no field for it. Every private `rev` and the poll's read digest now include a
body format (`k1`), so a cursor saved before keys were carried resumes as a change: each record is
sent again, with its key, and no cursor is expired.

This service carries the key on through: a registry item is `{"urn":…,"key":…,"rev":…,"data":…}`.
`?keyPrefix=P` (a key's grammar, at most 128 characters) keeps the records whose key starts with `P`
on the registry path and is sent on as the store's own `keyPrefix` on REST. A stream whose records
carry no key cannot be filtered: a `keyPrefix` read of it goes to REST (`unkeyed`). A prefix that
keeps none of a stream's records is an empty registry answer: the stream held records, so it was
not refused.

**Turn-on order:**

1. This service on a release with registry-only and `keyPrefix` (this one or later). An older one
   answers the shadow from REST, which reads the site again (counted `bad_response`).
2. **The registry adapter on a release with private keys (this one or later), before the shadow
   can compare by key.** Until then a keyed registry answer cannot exist: model-benchmarking's
   prefixed lists read `registry_miss{reason="unkeyed"}`, and its unprefixed ones compare on
   `basis="data"`.
3. The site on a release with the shadow, `APP_DATA_SHADOW_URL` set to this service's in-cluster
   URL (cluster-local `http` only).
4. The network path from the site's pods to this service's HTTP port (below).
5. Create `app-data-registry-shadow` in Flipt, on for model-benchmarking only.
6. Until the block exchange (`APP_DATA_BLOCK_EXCHANGE`) and the adapter's private relays (S7) are on,
   every shadow read is a `registry_miss` (`token_not_exchangeable` for a block token): that is the
   first thing it shows, and the positive control for the wiring.

**Infra it needs** (deployment config, not in this repo):

- the site's deployments (every one that serves `/api/v1/blocks/storage`) get `APP_DATA_SHADOW_URL`
  = this service's cluster-local Service URL and HTTP port (`APP_DATA_ADDR`, default `:8080`), and
  optionally the `APP_DATA_SHADOW_*` knobs;
- a network policy admitting the site's pods to this service on that port (ingress on this service,
  egress from the site if its egress is restricted). The metrics stay on their own path;
- no public route, no CORS origin and no new secret: the call is in-cluster and carries the
  request's own token.

## Depends on site changes not in this PR

- **An app's own collection on REST.** Hub tokens may import on REST now (#9783): an import is judged
  by `decideCollectionRead`, the predicate the private feed runs. Every fallback read names its source
  as `from=<slug>`, so a read of the token's OWN app's collection needs the storage route to treat a
  `from` naming the token's own app as an own read; today it refuses it (`import_not_declared`: no app declares an import of itself).
  civitai/civitai#9800 makes that change, for every token kind; the `from` this service sends is the
  blockId (the URN slug segment), which is what #9800 matches. Until it merges, an own-collection
  read falls back to that refusal, and only the registry path serves it. Do not deploy before #9800.
- **Record names (Q2).** A stream names a record by its record core URN (`…/<record_id>`), the REST
  list by its key. A private stream's record now also carries its key ("Private records carry their
  key" above), so an answer from either path can be matched by key. The REST list still does not
  expose `recordId` (`presentDocs` in `doc-store-api.ts`).

## Before merge

- `PrivateCursorPrefix` pinned to `private-feed.ts` by a golden vector, as `internal/urn` is to
  `urn.ts`. It can only be pinned once that file is on `main`.

## Not built

- Resuming a stream from its cursor (see "Token lifetime").
- A block-token stream outliving its block token's one exchange (see "Block tokens": the next read
  is REST's).
- Any write path (P3b), the app SDK serving side of P4 (a browser calling this service, which needs a
  public route; the shadow above is server-side), overlays.
- Deploy manifests and the image build.
- A true per-user cap: only per token, which is per (user, app).

## Defaults

The canary keeps the defaults above (operator, 2026-11-20): 100 streams per replica, 5-minute idle
TTL, 14-minute max age, 1.5 s live wait.
