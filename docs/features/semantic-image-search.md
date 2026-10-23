# Semantic image search: the vector index

Every eligible image (and, once enabled, video) has one embedding vector in Qdrant, kept in step
with Postgres. This doc covers the index and how it is filled and kept in sync. The code lives in
`apps/event-engine/src/vector-sync/`.

## Collection contract

|                     |                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Collection          | `images_wemm2b_256_v1` (`VECTOR_COLLECTION`)                                                |
| Read through        | alias `images_semantic` (`VECTOR_ALIAS`)                                                    |
| Model               | `wemm-2b`, 256 dimensions, normalized, cosine distance                                      |
| Point id            | `Image.id`                                                                                  |
| Collection metadata | `model`, `dimensions`, and after the first embed `modelRevision`, `profile`, `videoProfile` |

Payload, every field indexed, stored on disk:

| Field        | Type      | Source                                                     |
| ------------ | --------- | ---------------------------------------------------------- |
| `nsfwLevel`  | integer   | `Image.nsfwLevel`                                          |
| `tagIds`     | integer[] | enabled tags (`TagsOnImageDetails`, `disabled = false`)    |
| `baseModels` | keyword[] | distinct `ModelVersion.baseModel` of the image's resources |
| `type`       | keyword   | `Image.type`                                               |
| `userId`     | integer   | `Image.userId`                                             |
| `postId`     | integer   | `Image.postId`                                             |
| `sortAt`     | datetime  | `Image.sortAt`                                             |

Storage follows the configuration the vector-search benchmark measured: vectors and HNSW graph on
disk (`m` 16, `ef_construct` 128), int8 scalar quantization (quantile 1.0) kept in RAM. Queries
should use `rescore: true` with `oversampling: 2`.

**Never mix vectors.** The embedder reports the model revision and preprocessing profile with
every batch. The first batch records them in the collection metadata, and a later batch that
disagrees is refused (`ModelMismatchError`). A model change means a new collection, filled by the
backfill, and then an alias swap. Writers target the collection, readers the alias, so the old
collection keeps serving until the swap. `bootstrap` claims a free alias but never moves one that
points elsewhere. Moving it is the cutover, done by hand.

## What is embedded

The rule is in `eligibility.ts`, one table used for both the SQL predicate and the row check:
media that has finished ingestion, belongs to a post, and is not withheld from public listing.
Leaving that state deletes the point. Post visibility (published, private) is not part of the
rule; search results are hydrated through the site's normal image fetch, which applies it.

"New image" means _becoming_ eligible, usually when its scan completes, not the row insert. An
unscanned upload is never embedded.

Inputs are built per media type (`buildEmbedInput`):

- **image**: the image CDN's 512px-wide variant (the model's profile is 512x512 pixels), never
  the original.
- **video**: the original clip, at most 60 s and 100 MiB, at most 8 per batch, one vector per
  clip. Off until `VECTOR_EMBED_VIDEO=true`. Until then videos are counted as skipped.
- Rows whose `url` is an absolute URL (not a key on our CDN) are skipped.

## Embedding

`Embedder` submits orchestrator workflows with one `multimodalEmbedding` step, up to 128 inputs
each, tier `paid`. The step type is typed locally until the orchestration client ships it.

- At most `VECTOR_EMBED_MAX_IN_FLIGHT` workflows run at once per process.
- A 429 or 5xx backs off exponentially with jitter, never sooner than `Retry-After`. It gives up
  after `VECTOR_EMBED_MAX_RETRIES`. Each attempt at a batch has one `externalId`, reused across
  its retries, so a submit that succeeded server-side is not paid for twice. It is random rather
  than derived from the inputs, because the orchestrator would also return a _failed_ workflow
  for its key.
- A batch the orchestrator rejects (400, or a failed workflow) is split in half, at most four
  times (down to groups of 8), to isolate the bad input. What is still failing then is counted
  as `failed`, and the rest are embedded.
- When a batch fails for another reason (retries exhausted, auth, a model mismatch), batches not
  yet submitted are skipped. The vectors already returned are stored before the error is raised,
  so a retry pays only for what is missing.
- Every batch's model stamp is checked against the collection before its vectors are accepted.
  Until a model is recorded, a call's first batch runs alone, and checks are serialised within
  a process, so one process cannot record two models into a new collection. Across processes
  there is no compare-and-set, so the consumer never embeds into a collection whose model is
  not yet recorded: **the backfill canary records it first**. Until then the consumer only
  deletes and updates payloads.
- Step priority is `low` for backfill and reconcile, `normal` for live sync.

## Keeping it in sync

The sync is state-based: an event only says _which_ image to look at. `syncImageIds` re-reads
the current row, then:

| Current state             | Point exists | Action            |
| ------------------------- | ------------ | ----------------- |
| eligible                  | yes          | overwrite payload |
| eligible                  | no           | embed and upsert  |
| not eligible, or row gone | yes          | delete            |

This needs no before-image (REPLICA IDENTITY FULL), and a redelivered or reordered event is
harmless. After an upsert the rows are read once more. Anything no longer eligible is deleted,
and a payload that changed meanwhile (nsfwLevel, tags) is rewritten. That closes the window
where another worker applies a change while this one's embed is in flight.

### The consumer

`dist/vector-sync/consumer.js` runs from the event-engine image as its own process and consumer
group (`VECTOR_SYNC_CONSUMER_GROUP`, default `image-vector-sync`). It is deployed separately from
the metrics watcher and never configures the Debezium connector.

- It consumes `postgres.TagsOnImageNew` and `postgres.ImageResourceNew`, plus `postgres.Image`
  when `CDC_IMAGE_ENABLED=true`.
- Image ids collect for `VECTOR_SYNC_DEBOUNCE_MS`, so a burst of tag rows for one image becomes
  one re-read. Offsets are committed only after the Qdrant writes for everything before them
  succeed.
- It embeds only when `VECTOR_SYNC_EMBED_ENABLED` and `CDC_IMAGE_ENABLED` are both on. Block,
  review and scan changes touch only the Image row, so without Image events a blocked image
  would keep its vector. Otherwise it only deletes and updates payloads, and counts what it
  would have embedded as `embedOff`.
- Embedding is also **paused** while Kafka Connect (`DEBEZIUM_CONNECT_URL`) does not confirm
  that the connector streams `public.Image` and is running, or while the collection has no
  recorded model. It is checked at startup and every minute, and resumes when it passes again,
  so a Connect blip only pauses it. Images that needed embedding meanwhile are kept (in memory,
  up to 100k) and embedded on resume, at most 512 per flush so that deletes keep flowing; a
  restart loses that list, and the reconciler finds them.
  The health response shows `embedPaused` and `deferred`.
- It writes to Qdrant even with embedding off: it creates the collection, payload indexes and
  alias on startup, and applies deletes and payload updates. Deploy it only once its Qdrant is
  provisioned.
- If the embedder starts returning a different model than the collection holds, it stops
  embedding (deletes and payload updates continue) rather than paying for rejected vectors. The
  health response reports it (`embedding: false`, `embedStopped`). It lasts until the process
  restarts, which pays for one more flush before stopping again. A stop is permanent for the
  process, unlike a pause.
- `GET` on the health port answers 200 within 10 minutes of a successful flush. Past that it
  stays 200 while workflows keep returning vectors (within 45 minutes, longer than a batch's
  backoff plus the workflow timeout) and fewer than 3 flushes in a row have failed without
  storing any. So a liveness probe neither kills one
  slow embed mid-way nor hides a retry loop.

### Streaming the Image table

`public.Image` is not in the connector by default. `CDC_IMAGE_ENABLED=true` adds it to the
connector's `table.include.list` and to nothing the metrics watcher consumes. Set it first on
**the metrics watcher**, which manages the connector and creates the topic, and then on the
vector-sync consumer, which then subscribes to the topic. When it is flipped on the watcher:

- The watcher sees the include list differ on startup and **deletes and recreates the
  connector** under the same name, slot and publication. With
  `publication.autocreate.mode: filtered`, Debezium then alters the publication to add `Image`.
- Kafka Connect keeps a deleted connector's stored offsets, and the slot retains WAL from its
  last confirmed position. So the recreated connector resumes where it stopped. For tables
  already streamed, nothing is lost. Changes since the last offset flush are delivered again,
  which every consumer here treats idempotently. `snapshot.mode: never` means Image's existing
  rows are not snapshotted; the backfill covers them. Image changes from before the publication
  included the table are not streamed; the reconciler covers those.
- Image's whole write volume then goes through the one connector and slot that also feed the
  metrics watcher, which can add replication lag on the metrics topics. Each Image change also
  costs vector-sync three primary-key reads and a Qdrant read, batched per flush.

## Backfill

`node dist/vector-sync/backfill.js run --watermark <id> --confirm` embeds eligible images with
`id <= watermark`, newest first. Live sync covers everything above the watermark.

- Pages are id windows (`--span`, default 5000), not `LIMIT` queries. A page's cost is bounded by
  its span however sparse eligibility is, and each log line reports rows `scanned`.
  `--pages` (default 2) pages run at once.
- The cursor is kept in Redis (`vector-sync:{backfill:<collection>:<name>}:cursor`), so it
  survives restarts,
  deploys and reschedules. It moves past a page only once every page above it is written.
  Points that already exist are not re-embedded, so resuming over a page costs payload writes
  only. `--cursor-file` keeps it in a local file instead, for runs without Redis.
- `--dry-run` writes nothing, Qdrant or cursor, and reports what it would embed. `--limit N`
  stops after about N eligible images (it can overshoot by up to `--pages × --span` ids).
- `pause` / `resume` set a flag the run checks before each page. They, `status` and `reset`
  address the run for `VECTOR_COLLECTION` in their own env, and log it. `status` prints the cursor.
  `reset` clears it. SIGTERM finishes in-flight pages and stops.
- A run holds a lease (`...:lease` beside the cursor, renewed every 30 s, lapsing 2 minutes
  after the run dies), so a second copy of the same backfill refuses to start instead of
  paying for every page twice. A run that loses its lease stops and no longer writes the cursor.
- It re-checks the connector every 5 minutes; while it does not stream Image, no new page
  starts.
- Writing needs `--confirm`, `VECTOR_SYNC_EMBED_ENABLED=true` and `CDC_IMAGE_ENABLED=true`,
  so that live sync is already removing blocked images. Kafka Connect must also confirm the
  connector streams Image and is running. `--without-image-cdc` lifts the Image conditions for
  a canary; it needs `--limit`, and the reconciler should be run over the same range
  afterwards.

## Reconciler

`node dist/vector-sync/reconcile.js --to <id> [--from <id>] [--bucket 100000] --confirm` walks id
buckets newest first. In each one it compares the eligible ids in Postgres with the point ids in
Qdrant (an ordered scroll) and re-syncs the difference: missing ids embed, extra ids are re-read
and deleted if still ineligible. It checks presence only, not payload freshness. Eligible media it
cannot embed (videos while video is off, external URLs) shows as missing on every run and is
reported under `skipped`. Embedding follows the same conditions as the consumer, and it does
not record a new collection's model either. When they are not met, it still deletes and counts
the rest.
`--dry-run` only reports.

## Configuration

See the vector-sync block in `apps/event-engine/.env.example`.
