# app-data-go: the shared cache (valkey)

**Status:** built, off by default: with `APP_DATA_CACHE_URL` unset the service runs exactly as without
it (no connection, no new metric series, the same exchanges and streams). Decided by the operator on
2026-11-27: back the in-memory state with one valkey instance, **fail open**, so a single
non-highly-available valkey is enough for now; cache everything listed below, stream snapshots for warm
restarts included.

This follows [DESIGN.md](DESIGN.md) (the reads, the token exchange, the block cache) and
[WRITES-DESIGN.md](WRITES-DESIGN.md) (overlays and floors). Nothing here changes what they promise;
where a cached value could grant something the in-memory path would not, the rule below says why it
cannot. Code: `internal/cache` (the cache, the RESP client, what each kind holds), the hooks in
`internal/session` (SNAPSHOTS, RESUME, OVERLAYS AT REST), `internal/exchange/block.go`
(`SharedBlocks`), the wiring in `cmd/app-data-go` (`openCache`, `withCache`), and the adapter's first-
poll sync in `src/server/registry-adapter/private-feed.ts`.

## Why

Everything this service holds is in memory, so a restart (a rollout, a crash) loses it:

- **A block token's one exchange.** The hub refuses a second exchange of a block token as a replay
  (DESIGN.md, "Block tokens"), so after a restart every block token in use reads `block_token_spent`
  (with `APP_DATA_WRITES` on, `401`) until the SDK fetches a new one.
- **Every hub token's exchange**, made again at once by every active viewer, against the client's one
  exchange budget at the hub.
- **Every private stream's snapshot**, read again from the store by the adapter.
- **The overlays** (read-your-writes) of writes acknowledged just before the restart.

## What is cached

| Kind       | Key id (only its HMAC is in valkey)          | Value                                                                                                             | Lives                                                                  | Written                                                                                       | Read                                                                 |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `block`    | SHA-256 of the block token                   | the exchanged token and its expiry, or the hub's refusal (status, code), or a claim                               | token: until it expires (at most 15 min); refusal: 16 min; claim: 30 s | the exchange's claim (SET NX), then its answer                                                | before the hub is asked for a block token this process does not hold |
| `user`     | SHA-256 of the hub token                     | the exchanged token, its expiry, and when the hub last exchanged the subject (`checked`)                          | until the token expires (at most 15 min)                               | every exchange the hub answers, at a stream's open and at each re-check; deleted on a refusal | at a stream's open                                                   |
| `overlay`  | SHA-256 of the token, the schema             | a hash: one field per storage key (its name an HMAC too), each an acknowledged write and when its overlay expires | the newest overlay's expiry (one adapter poll plus 30 s)               | each acknowledged write, in the background                                                    | at a private stream's open (writes on)                               |
| `snapshot` | SHA-256 of the token, the schema, the region | a private stream's records and the cursor they are complete at                                                    | the idle TTL, never past the exchanged token's expiry                  | Sweep when the records changed, an idle close, shutdown                                       | at a private stream's open, never a floor's reopen                   |

Not cached: the level and per-viewer streams (shared collections, signed-out reads), the shared
overlays, a token this service refused locally (a block token failing its local check never reaches
valkey), the JWKS, and any REST answer.

## Key and value formats

- **Key names:** `adg:<format>:<kind>:<hex HMAC-SHA256(name key, kind ‖ 0 ‖ id)>`. The name key is
  derived from `APP_DATA_CACHE_KEY` (HMAC of the secret with a fixed label). No token, user, app,
  slug, collection or storage key appears in a name; a hash field is named the same way.
- **Values:** `format byte ‖ 12-byte nonce ‖ AES-256-GCM(JSON)`, under a seal key derived from the same
  secret with another label, with the value's full key name (and field) as additional data: a value
  moved under another name does not open. Every JSON value carries `v` (its own format).
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
- **The worst a dead valkey costs a read:** the read that opens a stream makes at most four calls
  (the cached exchange's read and, on a miss, its write; the stored overlays' read, writes on; the
  snapshot's read), each at most the timeout, and only until the breaker opens; after, none.
  Writes never wait on it: an overlay is stored in the background (at most 64 at once, past that
  dropped).
- **A dead valkey during a block-token exchange** fails open to exchanging as without the cache. Two
  processes may then both ask the hub for one block token; the hub issues to one and refuses the other
  as a replay, which is what happens without the cache.

## What a hit may do

A cached value grants nothing the in-memory path would not:

- **A block token** is checked here (signature, claims, age; `BlockVerifier`) before valkey is asked,
  as before the hub is. A cached answer is the hub's answer for that exact token (keyed by its
  digest): an issued token is handed to a stream as this process's own would be (never one with less
  than the expiry margin left: `spent`), and a refusal is remembered as a hub refusal is. A process
  that finds another's claim waits for its answer (at most 6 s) and never asks the hub itself; no
  answer is a failure, forgotten, as a failed exchange is.
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
- **An overlay** is applied by Ack's own rules (WRITES-DESIGN.md: only above the stream's head and the
  base's seq for its key, dropped by the head, by a `Delete` of its URN, by its expiry), and only to
  its own token's stream of its own schema. It was stored only after the store acknowledged the write,
  so it is a write the store holds. One whose expiry lies past the overlay TTL is not applied.

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
drops the token's cached exchange and its overlays.

**Resume, at a stream's open** (`session.Manager.follow`):

1. Exchange the token (cached within the re-check window, else the hub). Refused: nothing is loaded,
   the stream closes `exchange_refused`, and the snapshot is dropped.
2. Load the stored overlays (writes on), then the snapshot. The snapshot's cursor must be the private
   feed's (`b1.<binding>.p1.…`, `PrivateFeedCursor`), and its records within the stream's bounds,
   each with a URN, none twice; otherwise it is dropped unread (`discarded`).
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
  every 2 minutes. Either refusal closes the stream, drops its snapshot, the cached exchange and its
  overlays. Bound: 2 minutes after the hub last accepted the token, as before.
- A grant revoked, an install revoked, the app unapproved: the adapter's poll sends `Delete`s. A
  resumed stream is not answered before its first poll's changes arrive, so it serves nothing the
  adapter refused since the snapshot was saved.
- A block token's stream: as before (DESIGN.md, "No revocation re-check here"): the adapter's per-poll
  checks, and the exchanged token's 15 minutes.

## Bounds

- A snapshot holds what its stream held: at most `MAX_RECORDS_PER_STREAM` records and
  `MAX_BYTES_PER_STREAM` bytes (checked again on load). An overlay hash holds at most
  `MAX_RECORDS_PER_STREAM` fields.
- Every key has a time to live (the table above). Valkey is a cache: assume `allkeys-lru` eviction
  and no persistence. An evicted or lost key is a miss.
- Per process: at most `MAX_STREAMS` snapshots are written per Sweep, and only changed ones.

## Metrics

Registered only with the cache configured:

- `app_data_cache_ops_total{kind,op,outcome}`: `kind` block, user, overlay, snapshot; `op` get (`hit`,
  `miss`, `invalid`, `error`, `skipped_breaker`), set and del (`ok`, `error`, `skipped_breaker`), claim
  (`won`, `held`, `error`, `skipped_breaker`). `invalid` is a value that did not open (another key or
  format, garbage), read as a miss.
- `app_data_cache_breaker_open`: 1 while the breaker is open.
- `app_data_stream_resumes_total{outcome}`: `synced`, `cursor_refused`, `unsupported`, `discarded`.

Block-token answers from another process count as `app_data_block_exchanges_total{outcome="reused"}`
(an issued token) or `remembered` (a refusal), as this process's own do.

## Configuration

| Setting                                                    | Meaning                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DATA_CACHE_URL`                                       | the valkey instance: `rediss://` or `valkeys://`, or `redis://` / `valkey://` to a cluster-local `*.svc` host only; host, optional port (6379), optional `/db` (0-15); no credentials, query or fragment. Unset: no cache. Needs the registry path. |
| `APP_DATA_CACHE_KEY_FILE` / `APP_DATA_CACHE_KEY`           | the secret every name and seal is derived from (at least 32 bytes; a file, preferred, or the environment, never both). Required with the URL. Changing it turns every cached value into a miss.                                                     |
| `APP_DATA_CACHE_PASSWORD_FILE` / `APP_DATA_CACHE_PASSWORD` | optional: valkey's password (`AUTH` on each connection).                                                                                                                                                                                            |
| `APP_DATA_CACHE_OP_TIMEOUT_MS`                             | one valkey call's timeout, 5 to 2000 (default 100).                                                                                                                                                                                                 |

## A second replica

Nothing here assumes one process: the claim makes a block token's exchange once across every process
sharing the cache, a cached hub-token exchange and a snapshot are keyed by the token, not the process,
and a stored overlay reads back on any process that opens that token's stream. Not built: sticky
routing (WRITES-DESIGN.md "Several replicas"); a stream open on one replica does not see an overlay
another replica stored after it opened.

## Residual risks

1. **Valkey down for a block token's exchange:** two processes may each ask the hub, and one is
   refused as a replay (its reads answer `block_token_spent` until the SDK fetches a new block token),
   as without the cache.
2. **A claim whose holder dies** blocks other processes' exchange of that block token for up to 30 s
   (each waits 6 s, then fails); the block token's reads fail meanwhile, as they do today on any
   process that did not exchange it.
3. **A dead valkey costs a bounded delay:** up to four timeouts on a read that opens a stream, until
   the breaker opens, then none.
4. **Snapshot freshness:** a saved snapshot is never answered before its resume's first poll; the
   only cost of a stale one is a larger first diff.
5. **The adapter's sync is new:** until the adapter is released with it, every resume starts over
   (`unsupported` counts it), so restarts are as cold as before.

## Not built

- Snapshots of the level and per-viewer streams, and the shared overlays (`shared.Overlays`): after a
  restart their fresh snapshots already hold every committed write (WRITES-DESIGN.md, "A restart").
- Answering a read from a snapshot before its resume's sync (an instant warm answer): it would serve
  what a refusal since may have revoked.
- Resuming across an exchanged token's expiry (DESIGN.md, "Token lifetime"): a snapshot never lives
  past its exchanged token.
- High availability for valkey: not needed, by design.
