# app-data-go: the shared cache (valkey)

**Status:** built, off by default: with `APP_DATA_CACHE_URL` unset the service runs exactly as without
it (no connection, no new metric series, the same exchanges and streams). Decided by the operator on
2026-11-27: back the in-memory state with one valkey instance, **fail open**, so a single
non-highly-available valkey is enough for now, stream snapshots for warm restarts included. Narrowed
after the first review the same day: no overlays at rest, and no cross-process claim on a block
token's exchange ("Not built").

This follows [DESIGN.md](DESIGN.md) (the reads, the token exchange, the block cache) and
[WRITES-DESIGN.md](WRITES-DESIGN.md) (overlays and floors). Nothing here changes what they promise;
where a cached value could grant something the in-memory path would not, the rule below says why it
cannot. Code: `internal/cache` (the cache, the RESP client, what each kind holds), the hooks in
`internal/session` (SNAPSHOTS, RESUME), `internal/exchange/block.go` (`SharedBlocks`), the wiring in
`cmd/app-data-go` (`openCache`, `withCache`), and the adapter's first-poll sync in
`src/server/registry-adapter/private-feed.ts`.

## Why

Everything this service holds is in memory, so a restart (a rollout, a crash) loses it:

- **A block token's one exchange.** The hub refuses a second exchange of a block token as a replay
  (DESIGN.md, "Block tokens"), so after a restart every block token in use is refused until the SDK
  fetches a new one.
- **Every hub token's exchange**, made again at once by every active viewer, against the client's one
  exchange budget at the hub.
- **Every private stream's snapshot**, read again from the store by the adapter.

## What is cached

| Kind       | Key id (only its HMAC is in valkey)          | Value                                                                                    | Lives                                                 | Written                                                                                       | Read                                                                 |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `block`    | SHA-256 of the block token                   | the exchanged token and its expiry                                                       | until the token expires (at most 15 min)              | when the hub issues it                                                                        | before the hub is asked for a block token this process does not hold |
| `user`     | SHA-256 of the hub token                     | the exchanged token, its expiry, and when the hub last exchanged the subject (`checked`) | until the token expires (at most 15 min)              | every exchange the hub answers, at a stream's open and at each re-check; deleted on a refusal | at a stream's open                                                   |
| `snapshot` | SHA-256 of the token, the schema, the region | a private stream's records and the cursor they are complete at                           | the idle TTL, never past the exchanged token's expiry | Sweep when the records changed, an idle close, shutdown                                       | at a private stream's open, never a floor's reopen                   |

Not cached: the overlays (read-your-writes; "Not built"), the level and per-viewer streams (shared
collections, signed-out reads), any refusal (the hub's or this service's), the JWKS, and any REST
answer.

## Key and value formats

- **Key names:** `adg:<format>:<kind>:<hex HMAC-SHA256(name key, kind ‖ 0 ‖ id)>`. The name key is
  derived from `APP_DATA_CACHE_KEY` (HMAC of the secret with a fixed label). No token, user, app,
  slug, collection or storage key appears in a name.
- **Values:** `format byte ‖ 12-byte nonce ‖ AES-256-GCM(JSON)`, under a seal key derived from the same
  secret with another label, with the value's full key name as additional data: a value moved under
  another name does not open. Every JSON value carries `v` (its own format).
- **Rotation or a format change is a miss:** another secret derives other names and seals that do not
  open; another format byte or `v` is unread. Nothing has to be flushed.
- **Per token and per schema:** every id starts with the token's digest (and the schema, and the
  region for a snapshot), so nothing cached for one token can be read by a request with another.

## Fail open

- **Optional.** `APP_DATA_CACHE_URL` unset: no hook is wired (`cmd/app-data-go`), and the session
  options are the ones without a cache.
- **Bounded.** Every valkey call has its own timeout (`APP_DATA_CACHE_OP_TIMEOUT_MS`, default 100 ms),
  set apart from the caller's context: a read that gives up never counts as valkey failing.
- **Errors are misses and no-ops.** A refused connection, a timeout, a server error, a value that does
  not open (another key, garbage) is a miss for a read and nothing for a write; no caller sees an
  error from the cache.
- **The breaker.** After 5 consecutive failures valkey is not called for 30 s; then one call at a time
  is let through until one succeeds. A miss is not a failure. While it is open every call is
  `skipped_breaker`, costing nothing.
- **Startup never waits on valkey:** the first connection is made by the first call.
- **The worst a dead valkey costs a read:** the read that opens a stream makes at most three calls (the
  cached exchange's read and, on a miss, its write; the snapshot's read), each at most the timeout,
  and only until the breaker opens; after, none. The write path makes none.

## What a hit may do

A cached value grants nothing the in-memory path would not:

- **A block token** is checked here (signature, claims, age; `BlockVerifier`) before valkey is asked,
  as before the hub is. A cached answer is the token the hub issued for that exact block token (keyed
  by its digest), handed to a stream as this process's own would be, never one with less than the
  expiry margin left (`spent`). Only an issued token is saved, never a refusal.
- **A hub token's** cached exchange is used to open a stream only while the hub's last exchange of
  that token is younger than the re-check interval (2 minutes, DESIGN.md "Token lifetime"), and the
  stream's re-check counts from that exchange, not from the open. So a revoked token is served for at
  most 2 minutes after the hub last accepted it, as a live stream already is. A re-check always asks
  the hub; a refusal deletes the cached exchange at once, so no other stream of that token opens from
  it.
- **A snapshot** is never answered on its own. It seeds a stream that resumes from its cursor (below),
  under a token exchanged as above, and the stream is answered only once the adapter says its first
  poll is in: every `Delete` it missed (a grant revoked, a record deleted) is applied before any read.
  A token refused at the open loads nothing.

## Block tokens: no claim

A process that holds no exchange for a block token reads the cache, and on a miss asks the hub
(`exchange.BlockCache`'s single exchange per token within the process stays), then saves the issued
token. There is no cross-process claim. Two processes can both miss only while both run, which at one
replica is a rollout's surge overlap: both then ask the hub, the hub issues to one and refuses the
other's replay, and the loser remembers that refusal as any refusal. Its reads of that block token are
then refused (`exchange_refused`) until the SDK fetches a new block token: what happens today whenever
a block token is read on a process that did not exchange it. The loser never waits, and is never
handed another token's exchange. A third process later reads the winner's token from the cache.

## The resume algorithm

The design originally rejected resuming (DESIGN.md, "Token lifetime"): it needs cursor tracking, and
a resume's first poll must deliver every `Delete` missed. This is how both are met.

**The consistent cursor.** The private feed sends a poll's changes as a batch whose events carry the
cursor before the batch, except the last, which carries the poll's new cursor (`private-feed.ts`,
`follow`). A `Live` and a `Progress` come after a whole poll. So the records are complete at a cursor
only at a `Live`, a `Progress`, or an event whose cursor differs from the one held (the end of a
batch). An event carrying the cursor already held is mid-batch, and the records are at no cursor until
the batch ends: saving there and resuming from the earlier cursor would miss a `Delete` of an entity
the batch upserted. A snapshot is saved only at a consistent cursor.

**Saved:** by Sweep (at most every 10 s) when the records changed since the last save, at an idle
close, and at shutdown (`SIGTERM` closes every stream). Never a stream not yet live, one not yet synced
(a resume), or one mid-batch.

**Dropped:** when a stream ends because its token or its data was refused (`exchange_refused`,
`revoked`, `invalid_token`, `not_private`, `too_large`, `malformed`, `end`, `cursor_expired`, a
classified exchange failure). A token refusal (`exchange_refused`, `revoked`, `invalid_token`) also
drops the token's cached exchange.

**Resume, at a stream's open** (`session.Manager.follow`):

1. Exchange the token (cached within the re-check window, else the hub). Refused: nothing is loaded,
   the stream closes `exchange_refused`, and the snapshot is dropped.
2. Load the snapshot. Its cursor must be the private feed's (`b1.<binding>.p1.…`,
   `PrivateFeedCursor`), and its records within the stream's bounds, each with a URN, none twice;
   otherwise it is dropped unread (`discarded`).
3. Subscribe with `cursor=<saved>` and request `meta` `{"sync":1}`.
4. The adapter answers:
   - **the cursor refused** (`cursor_expired` or `bad_request`: expired, its state gone, issued to
     another token's subject, the seqs restarted): the snapshot is dropped, the records cleared, and
     the stream subscribes again without a cursor (`cursor_refused`);
   - **`Live` with a cursor not the private feed's:** closed `not_private`, as any stream;
   - **`Live` not naming `sync: pending`** (an adapter before the sync): start over as above
     (`unsupported`), since nothing would say when the missed `Delete`s have arrived;
   - **`Live` naming `sync: pending`:** the cursor held. The first poll's changes follow (every
     `Delete` and `Upsert` since the cursor), then a `Progress` naming `sync: done`. Reads wait for it
     as a fresh stream's reads wait for `Live` (bounded by `LIVE_WAIT_MS`); at it the stream serves
     (`synced`). A refused cursor before it starts over.

**The adapter's side** (`private-feed.ts`, THE FIRST POLL'S SYNC): a subscription whose `meta` names
`sync: 1` gets `sync: 'pending'` in its `live` meta and, after the first poll's changes, one
`progress` naming `sync: 'done'` (beside the head and current major when served), whether or not
anything changed. Without it nothing differs. The request's `meta` is not part of a cursor's binding,
so asking never expires a cursor. **Deploy order:** none needed for correctness. An app-data-go with the
cache against an adapter without the sync starts every resume over (`unsupported`): correct, only not
warm.

**Never resumed:** a stream reopened for a read's floor (it wants fresh heads), the level and per-viewer
streams.

## Revocation, unchanged

- A banned user, a signed-out session, the app's tokens revoked: the hub refuses the user's token. A
  stream that opens asks the hub unless it exchanged that token within 2 minutes; a live one re-checks
  every 2 minutes. Either refusal closes the stream and drops its snapshot and the cached exchange.
  Bound: 2 minutes after the hub last accepted the token, as before.
- A grant revoked, an install revoked, the app unapproved: the adapter's poll sends `Delete`s. A
  resumed stream is not answered before its first poll's changes arrive, so it serves nothing the
  adapter refused since the snapshot was saved.
- A block token's stream: as before (DESIGN.md, "No revocation re-check here"): the adapter's per-poll
  checks, and the exchanged token's 15 minutes.

## Bounds

- A snapshot holds what its stream held: at most `MAX_RECORDS_PER_STREAM` records and
  `MAX_BYTES_PER_STREAM` bytes (checked again on load).
- Every key has a time to live (the table above). Valkey is a cache: assume `allkeys-lru` eviction
  and no persistence. An evicted or lost key is a miss.
- Per process: at most `MAX_STREAMS` snapshots are written per Sweep, and only changed ones.
- A reply from valkey is read only as far as the bytes that arrive: a bulk is at most 256 MiB, an array
  at most 1,048,576 elements and 4 deep (`internal/cache` `readReply`, fuzzed by `FuzzReadReply`).

## Metrics

Registered only with the cache configured:

- `app_data_cache_ops_total{kind,op,outcome}`: `kind` block, user, snapshot; `op` get (`hit`, `miss`,
  `invalid`, `error`, `skipped_breaker`), set and del (`ok`, `error`, `skipped_breaker`). `invalid`
  is a value that did not open (another key or format, garbage), read as a miss.
- `app_data_cache_breaker_open`: 1 while the breaker is open.
- `app_data_stream_resumes_total{outcome}`: `synced`, `cursor_refused`, `unsupported`, `discarded`.

A block token's exchange read from the cache counts as `app_data_block_exchanges_total{outcome="reused"}`,
as this process's own reuse does.

## Configuration

| Setting                                                    | Meaning                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DATA_CACHE_URL`                                       | the valkey instance: `rediss://` or `valkeys://`, or `redis://` / `valkey://` to a cluster-local `*.svc` host only; host, optional port (6379), optional `/db` (0-15); no credentials, query or fragment. Unset: no cache. Needs the registry path. |
| `APP_DATA_CACHE_KEY_FILE` / `APP_DATA_CACHE_KEY`           | the secret every name and seal is derived from (at least 32 bytes; a file, preferred, or the environment, never both). Required with the URL. Changing it turns every cached value into a miss.                                                     |
| `APP_DATA_CACHE_PASSWORD_FILE` / `APP_DATA_CACHE_PASSWORD` | optional: valkey's password (`AUTH` on each connection).                                                                                                                                                                                            |
| `APP_DATA_CACHE_OP_TIMEOUT_MS`                             | one valkey call's timeout, 5 to 2000 (default 100).                                                                                                                                                                                                 |

## Residual risks

1. **Two processes running at once** (a rollout's overlap) can both miss a block token and both ask
   the hub; the loser is refused as a replay, as without the cache ("Block tokens: no claim").
2. **A dead valkey costs a bounded delay:** up to three timeouts on a read that opens a stream, until
   the breaker opens, then none.
3. **Snapshot freshness:** a saved snapshot is never answered before its resume's first poll; the
   only cost of a stale one is a larger first diff.
4. **The adapter's sync is new:** until the adapter is released with it, every resume starts over
   (`unsupported` counts it), so restarts are as cold as before.

## Not built

- **Overlays at rest** (read-your-writes across a restart). After a restart a private stream is
  answered only once it holds every committed write: a fresh snapshot is read by the adapter's private
  feed (`advance`) through the document store's own connection (`appdataDb`), the one its writes
  commit on, not a replica; a resumed stream only after its sync, which is such a read too. A stored
  overlay would add nothing. The overlays stay in memory, exactly as before.
- **A cross-process claim on a block token's exchange** ("Block tokens: no claim"): it only matters
  while two processes run at once, and its cost (a wait, a claim a dead holder leaves behind) outweighs
  degrading to today's refusal there.
- Snapshots of the level and per-viewer streams, and the shared overlays (`shared.Overlays`): after a
  restart their fresh snapshots already hold every committed write (WRITES-DESIGN.md, "A restart").
- Answering a read from a snapshot before its resume's sync (an instant warm answer): it would serve
  what a refusal since may have revoked.
- Resuming across an exchanged token's expiry (DESIGN.md, "Token lifetime"): a snapshot never lives
  past its exchanged token.
- High availability for valkey: not needed, by design.
