# Semantic video search

Every eligible video has one vector in its own collection, made from the clip itself by the same
model as images (`wemm-2b`, 256-d). Text, image and video vectors share one space, so a text
query or an image anchor can be searched against videos.

| | |
| --- | --- |
| Collection | `videos_wemm2b_256_v1` (`VECTOR_VIDEO_COLLECTION`), read through alias `videos_semantic` |
| Instance | the site-search Qdrant, with the other content collections (two copies of each shard) |
| Writer | the `video` domain of content-vector-sync (`apps/event-engine/src/vector-sync/videos/`) |
| Point id | `Image.id` |

## What is embedded

The image rule (`eligibility.ts`) for rows with `type = 'video'`, plus the held-media rule the
other content indexes apply (`held.ts`). Leaving that state deletes the point.

The payload is the image payload (`nsfwLevel`, `tagIds`, `baseModels`, `modelVersionIds`,
`userId`, `postId`, `sortAt`, `type`), so searches filter videos exactly as they filter images,
plus the stored key `url`. `docHash` is a hash of the key: a replaced file is re-embedded.

Inputs are the original clip. The worker refuses clips over 60 s, 100 MiB or 4096 px per side;
those get no document, so they are never sent and never retried (counted as
`vector_sync_points_skipped_total{domain="video"}` by reason). A clip with no recorded duration
is sent, and the worker's own limit decides.

## Media the worker refuses

A clip the orchestrator rejects on its own (a lone input refused, or a failed step in a workflow
that otherwise ran; for example a codec it cannot decode) is remembered in Redis by id and
`docHash` for 3 days (`videos/rejected.ts`). Until the file changes or the entry expires, it is
treated as having nothing to embed, so the refresh walk does not pay for the same failure every
pass. Outage failures, steps that report success with an unusable output, and calls where most
inputs fail are not remembered. A Redis error sends the clip again rather than failing the sync. Refusals count as
`vector_sync_points_total{domain="video",outcome="refused"}`.

## Keeping it in sync

The domain framework, as for the other content indexes:

- **CDC**: `postgres.Image` (non-video updates dropped at routing), `postgres.TagsOnImageNew` and
  `postgres.ImageResourceNew`. Embedding needs all three streamed.
- **Refresh walk**: re-syncs every video id and visits the collection's points in the same id
  range, so a point whose row is gone or no longer qualifies is deleted. It reads `Image`
  filtered to videos; the partial index `Image_video_id_idx` keeps that cheap. Its interval is
  `VECTOR_VIDEO_REFRESH_MINUTES`.
- **Backfill**: `node dist/vector-sync/content/backfill.js --domain video --to <id> --confirm`,
  newest id first. Use `--limit` as a cap on a slice and `--max-rate <writes/s>` to pace it; the
  embed workers also carry the live image sync, so watch its lag and pause if it climbs. The
  per-process embed rate is `VECTOR_EMBED_MAX_STEPS_PER_SECOND`.
