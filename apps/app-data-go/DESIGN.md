# app-data-go: design

**Status:** scaffold for review (P3 slice S5). Not deployed, and not to merge before the registry
adapter's private streams (S2) merge.

One shared service that serves app clients their users' **private** app data read through the
registry. Browsers never subscribe to the registry themselves: an app calls this service with the
token it holds for the signed-in user, and the service reads that user's stream. Decided on
civitai/civitai-registry#49: option (a), one lazy, short-lived stream per **active** user, opened with
**that user's** token, so the origin (the registry adapter's private feed,
`src/server/registry-adapter/private-feed.ts`) stays the only judge of what the user may read. This
service decides no access of its own.

## The read

```
GET /v1/apps/{slug}/collections/{collection}/records[?major=N][&import=1]
Authorization: Bearer <the app's hub access token for the user>
```

1. Validate `slug`, `collection` and `major` and build the collection's schema URN,
   `urn:schema:apps.civitai.com:<slug>/<collection>@v<major>` (`internal/urn`, pinned to the adapter's
   `registryUrn` by golden vectors).
2. If the registry path is on and the token is one the hub can exchange (below), read the token's
   stream for that schema (`internal/session`): open it if none is open, wait for its `Live` at most
   `LiveWait`, and answer from its cache. A stream answers only once it has sent `Live` (the spec's
   Consumers rule 2: `Live` means the snapshot is complete). Closing at `Live` would make each read a
   query (the spec's "query mode"); the stream is kept open instead, so the next reads within the
   idle TTL are answered from memory and changes (including revocations) keep arriving.
3. Otherwise, or when the stream cannot answer (see the fallback reasons), read the site's document
   store REST list with the same token (`internal/rest`): `GET /api/v1/blocks/storage/<collection>`,
   with `?from=<slug>` for an import. The site judges that read exactly as it judges the app calling
   it directly: an import by `decideCollectionRead` (the same predicate the private feed runs), an
   app's own storage by `resolveStorageAccess`. A site refusal (401/403/404/429) is passed on as the
   site sent it.

The whole read is bounded by `RequestDeadline`; `LiveWait < RequestDeadline` is enforced at start so
the fallback always has time.

An **empty** stream is not trusted: the origin answers a token it refuses with an empty snapshot and
`Live`, exactly as it answers a user who holds nothing (S2's "a refused subscriber learns nothing").
Only REST can tell the two apart, so an empty stream answer goes to REST (`reason="empty"`). This is
also what makes a fully revoked grant answer the site's `403` rather than an empty list.

## Which token, and who exchanges it

Read against the hub's exchange (`apps/auth/src/lib/server/oauth/user-exchange.ts`):

- The subject token of an exchange must be one of the hub's **original OAuth access tokens** (step 5
  looks it up among them by hash). An exchanged JWT is not one, so it **cannot be exchanged again**;
  a block token (the site's own signed JWT) is not one either.
- The caller of an exchange is either the app the token was issued to (it authenticates with the
  app's client secret) or a **relay** the resource lists; a relay is named in the result's `act.sub`.
- The adapter's private feed serves only a token whose `act.sub` is in
  `REGISTRY_ADAPTER_PRIVATE_RELAYS`, which S2 plans to set to `registry-exp`'s own client.

So this service **does not exchange the token**. It cannot exchange as the app (it holds no app's
client secret), and exchanging as a relay itself would produce a JWT `registry-exp` could no longer
exchange, so the one hop that carries the user and the app to the adapter would be refused. It sends
the user's hub access token to `registry-exp` as the subscription's bearer token; `registry-exp`
exchanges it at the hub as itself for `resource: https://apps.civitai.com` (the auth extension's
Relays rule 1), and the adapter sees `sub` = the user, `client_id` = the app, `act.sub` =
`registry-exp`. This is the single-hop path described on #49.

A token without the hub's access-token prefix (`civitai_`) is never sent to the registry: it could
not be exchanged, and the relay would read the adapter without a token and stream nothing. Those
reads go straight to REST (`reason="token_not_exchangeable"`).

## Isolation

A stream and its cache are keyed by **SHA-256(token) + schema**. Nothing here decodes a token or knows
whose it is, so a record received on one token's stream can only be read back with the same token.
Two tokens of the same user are two streams (the auth extension's Relays rule 2: an authorized stream
belongs to one consumer). Responses are `Cache-Control: private, no-store` and
`Vary: Authorization`. Metrics never carry a token, user, app or collection.

Tests prove it with pairwise-distinct fixtures (`TestRecordsNeverCrossFromOneTokenToAnother`,
`TestTwoUsersNeverSeeEachOthersRecords`), interleaved and concurrent, plus a user who holds nothing.

## Stream lifecycle and caps

| Setting                  | Default | Meaning                                                              |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `MAX_STREAMS`            | 100     | streams open in the process                                          |
| `MAX_STREAMS_PER_TOKEN`  | 4       | streams one token holds (one per collection it reads)                |
| `STREAM_IDLE_TTL_MS`     | 300000  | a stream no read used for this long is closed                        |
| `STREAM_MAX_AGE_MS`      | 1800000 | a stream is closed this long after it opened, read or not            |
| `LIVE_WAIT_MS`           | 1500    | how long a read waits for a new stream's `Live`                      |
| `REQUEST_DEADLINE_MS`    | 4000    | one read, REST included                                              |
| `MAX_RECORDS_PER_STREAM` | 1000    | a stream whose cache outgrows this is closed; reads go to REST       |
| `MAX_BYTES_PER_STREAM`   | 2 MiB   | likewise, by approximate size; caches hold at most streams × this    |
| `REST_MAX_INFLIGHT`      | 64      | concurrent REST reads; over it a read answers 503 with `Retry-After` |

A read that would open a stream over either cap opens nothing and reads REST (`capacity`,
`token_capacity`). A stream that failed is not reopened for 30 s (`cooling_down`), so a broken
registry is not asked again on every read. A stream that ended, failed or outgrew its bounds drops
its cache with it: nothing is served from a stream that stopped following.

## Stream count against the adapter's caps

The adapter caps open subscriptions in total, per client address and per token subject
(`limits.ts`; code defaults 2000 / 100 / 100, overridable by env). With the caps set as the operator
described for this rollout — **500 in total, 250 per address, 50 per token** — the arithmetic is:

- **Per address is the binding cap.** Every private stream reaches the adapter from `registry-exp`,
  so all of them, for every user, count against `registry-exp`'s address(es): one relay pod can hold
  at most 250 adapter streams, shared with anything else that pod subscribes to there. Each private
  stream this service opens is one adapter stream (Relays rule 2: an authorized stream is never
  shared). So `MAX_STREAMS` × replicas of this service must stay under 250 × relay pods, less the
  relay's other streams from that address, and under 500 less every public subscriber.
- **Per token (50) does not bind:** the subject is (user, app), and this service opens at most
  `MAX_STREAMS_PER_TOKEN` (4) per token.
- **How many streams are open:** by Little's law, open ≈ (new active (user, collection) pairs per
  second) × (session length + idle TTL), capped at the shortest of max age. At 1 new pair/s and a
  5-minute idle TTL with short sessions, that is about 300 open, already over the per-address cap. The
  default of 100 per replica is chosen to stay well under it; past the cap reads go to REST, which is
  correct, only slower.
- **Load on the adapter:** each private stream re-runs the predicate and re-reads one user's
  collection every adapter poll (S2: about 5 queries per poll, default 60 s). 100 streams ≈ 8 queries/s.

Lowering the idle TTL is the main lever; S2 also asks whether private streams should poll more slowly.

## The relay stall (civitai/civitai-registry#50)

A relay sends `Live` only once every upstream that has not ended is live, so one unreachable origin
behind `registry-exp` keeps **every** stream through it from reaching `Live`, for every schema. Here
that would mean every read waits and then falls back. The service bounds the cost:

- a read waits at most `LIVE_WAIT_MS` for `Live`, then reads REST (`not_live`);
- a stream that has made one read give up is **stalled**: later reads go to REST at once instead of
  waiting again (`stalled`), and a stall does not count as use, so it closes at the idle TTL; a
  stream that reaches `Live` later serves normally again;
- `REST_MAX_INFLIGHT` bounds the REST load a stall shifts onto the site.

So during a stall the cost is one `LIVE_WAIT_MS` per (token, collection) per idle TTL, plus REST for
every read. If #50 lands as proposed (a relay may send `Live` without an unreachable upstream, naming
it in `Live`'s `meta`), nothing here needs to change: `Live` is `Live`.

## Revocation

A grant revoked, the import scope withdrawn, the app unapproved, the user no longer allowed to run
apps: the adapter's next poll (S2) sends a `Delete` for each record the stream held, and the cache
drops them (`TestADeleteRemovesTheRecordFromTheCache`,
`TestARevokedGrantLeavesTheCacheAndTheSiteAnswersTheRefusal`). An upsert without a body is a delete
too (the spec's Validity rule 2). A change the cache cannot apply (a malformed upsert, delete or live)
ends the stream rather than risk serving a record that should have left. The lag is the adapter's
poll plus the time to the next read; REST reads see a revocation at once.

## Not built

- Resuming a stream from its cursor after a failure (a fresh snapshot is opened on the next read).
- Any write path (P3b), the app SDK side (P4), overlays.
- Deploy manifests, the release script entry, the token-expiry recheck (the relay ends a stream with
  `invalid_token`, Relays rule 4, which this service handles).
- A true per-user cap (only per token; see the open questions).

## Open questions

1. **Token forwarding.** This service sends the user's hub access token to `registry-exp`, which
   exchanges it. That needs `registry-exp`, as a resource server, to accept a consumer's hub access
   token (the auth extension's Resource servers rule 3 says a registry accepts tokens issued for
   itself). Is that what `registry-exp` does on the direct apps path, or should this service instead
   be the relay itself, reading the adapter directly and listed in `REGISTRY_ADAPTER_PRIVATE_RELAYS`
   (no relay hop, so no #50 stall, but a second listed relay)?
2. **Record names differ by source.** A stream names a record by its URN (`…/<record_id>`); the REST
   list names it by key. An app cannot match one to the other. Should the adapter put the key in the
   entity's `meta`, or the REST list return `recordId`?
3. **Shared collections.** The private feed serves only collections declared `private`; for a shared
   collection the schema is the public feed's, which serves something else than the REST list. Should
   this service refuse non-private collections (it does not know a collection's visibility today)?
4. **Own app's slug.** For an app's own read the client names its slug; REST reads the token's own app
   whatever the slug says. A client naming another slug without `import=1` gets that app's data from
   the registry if the user granted it, and its own app's from REST. Is the slug check worth a REST
   info read, or should the adapter report which basis served the stream?
5. **Per-user cap.** The service cannot see the user behind an opaque token, so the cap is per token
   (per user and app). Is that enough, or should the service introspect?
6. **Defaults.** 100 streams per replica, 5-minute idle TTL, 30-minute max age, 1.5 s live wait: right
   for the first `registry-exp` canary?
