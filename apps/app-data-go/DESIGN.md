# app-data-go: design

**Status:** scaffold for review (P3 slice S5). Not deployed. Not to merge before the registry
adapter's private streams (S2, #9758) merge, and not to deploy before the prerequisites below.

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
`Live`:

- the private feed's cursors start with `p1.` (`PrivateCursorPrefix`);
- the public feeds' cursors start with `c1.`.

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
  them by hash). A token without the hub's access-token prefix (`civitai_`), such as a block token,
  is therefore never sent to the hub: those reads go straight to REST (`token_not_exchangeable`).
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

The client secret is read from a file (`APP_DATA_CLIENT_SECRET_FILE`, preferred) or the environment,
never both, and no error, log or metric carries it or any token.

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
keep a stream past its token. The expiry close is the one that normally fires.

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

A revoked user token ends the stream at the next exchange, at most ~14.5 minutes later. The lag is
the adapter's poll plus the time to the next read. REST reads see a revocation at once.

## Depends on site changes not in this PR

- **Hub-token imports on REST.** Today the site refuses every `from` on a hub token
  (`import_hub_token`), so the REST fallback answers that refusal and only the registry path serves a
  hub token. The operator decided that hub tokens may import when the user grants it, and a separate
  site PR lifts the refusal. After it:
  - an import is judged by `decideCollectionRead`, the predicate the private feed runs;
  - a `from` naming the token's own app reads that app's own storage. That is how every fallback
    read names its source here, so the site PR must keep a self-`from` an own read rather than
    refuse it as an import of itself.
- **Record names (Q2).** A stream names a record by its record core URN (`…/<record_id>`), the REST
  list by its key, and an app cannot match the two. The REST list should expose `recordId`: the
  store reads it (`doc-store.ts`), but `presentDocs` in `doc-store-api.ts` does not return it.

## Before merge

- S2 (#9758) merged, and this branch rebased onto it.
- `PrivateCursorPrefix` pinned to `private-feed.ts` by a golden vector, as `internal/urn` is to
  `urn.ts`. It can only be pinned once that file is on `main`.

## Not built

- Resuming a stream from its cursor (see "Token lifetime").
- Any write path (P3b), the app SDK side (P4), overlays.
- Deploy manifests and the image build.
- A true per-user cap: only per token, which is per (user, app).

## Open questions

1. **Scope of the exchanged token.** `APP_DATA_EXCHANGE_SCOPE` is optional; unset, the hub issues the
   resource's ceiling. Should it be narrowed to `AppDataRead`, and in which form does the hub parse it?
2. **Defaults for the first canary:** 100 streams per replica, 5-minute idle TTL, 14-minute max age,
   1.5 s live wait. Are these right?
