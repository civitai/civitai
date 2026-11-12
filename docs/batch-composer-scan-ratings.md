# Batch composer: ratings before the posts exist

Status: proposal, awaiting a decision.

Testers asked to see each image's rating in the `/posts/batch` grid once it is scanned, as the post
editor shows it. Today the grid can't: the composer uploads to S3 and keeps the keys in an IndexedDB
draft, and no `Image` row exists until `post.scheduleBatch` creates the posts
(`docs/batch-scheduling-ux.md`: "Nothing is created on the server until **Schedule N posts**").

## What a scan needs

The scan is keyed to an `Image` row from submit to result. `ingestImage` (`image.service.ts`) sends
`imageId` to the orchestrator, and the result path (`image-scan-pipeline.ts`) writes tags to that row,
runs moderation rules, computes `nsfwLevel` from the tags, can block the image, notifies the owner and
queues follow-up review. None of this runs against an S3 key alone.

The pipeline already accepts a row with `postId = null`: `applyIngestionSideEffects` only busts post
caches when there is a post, and the image search index skips postless rows. `post-intent.service.ts`
creates postless rows and then adopts them into a post with
`updateMany({ where: { id, userId, postId: null } })`.

## Options

| Option                                                  | Verdict                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Postless `Image` row per upload, adopted at schedule | **Recommended.** Same pipeline and same signal as the editor. Costs: a scan for every upload, including abandoned ones, and leftover rows that need a sweep.                                                       |
| B. Scan the S3 key with no row                          | Rejected. Needs a second result path for tags, rules and blocking with nowhere to store them. `scheduleBatch` can't trust a rating the client sends, so each image would be scanned again at submit, paying twice. |
| C. Poll after submit                                    | Rejected. The composer's work is done by then. This is what testers already do on each post.                                                                                                                       |

## Plan for option A

1. **`post.createBatchImage`** (guarded, `batchPostScheduling` flag, `MediaWrite` scope). Input is
   `scheduleBatchImageSchema`. Calls `createImage` with no `postId`, which queues ingestion, then
   `createImageResources`. Marks the row as a batch upload in `metadata` so the sweep can find it.
   Refuses once the caller has `POST_BATCH_MAX_IMAGES` unadopted batch rows. That cap is the only
   bound on scan spend, because this path skips the post rate limit. Returns
   `{ id, ingestion, nsfwLevel }`.
2. **`scheduleBatch` adopts the rows.** `scheduleBatchImageSchema` gains an optional `imageId`.
   With it, adopt the row with `updateMany({ id, userId, postId: null })` and set `postId`/`index`,
   instead of `addPostImage`. If the count is short, fail the post through the existing
   `discardFailedPost` path. Then call `updatePostNsfwLevel` for the post: a scan that finished
   before adoption had no post to update. Payloads without `imageId` keep the current path, so
   bundles from before this change still work.
3. **The signal carries `nsfwLevel`.** `sendIngestionSignal` sends only `ingestion` and
   `blockedFor`. Add `nsfwLevel` from the scan outcome, and have `SignalsRegistrar` write it into
   `imageStore`. The post editor gets this too: its badge reads `nsfwLevel` from `post.getEdit`, and
   the current signal doesn't update it.
4. **The composer.** `onComplete` calls `createBatchImage` and stores `imageId` on the media item
   and in the draft. `MediaThumb` reads `useImageStore({ id, ingestion, nsfwLevel })` and shows
   `BrowsingLevelBadge` once scanned, a spinner while `Pending`, and the existing Blocked overlay for
   a server block. A draft restored after a reload calls `image.get` for rows still pending, since
   their signals were missed. Removing a thumb calls `image.delete`.
5. **The sweep.** A job deletes unadopted batch rows older than a set age, through `deleteImages`,
   which also removes the S3 object. This is the one new path that deletes data. It must select only
   rows that are postless, marked as batch uploads and past the age.
6. **Docs.** Update `docs/features/batch-post-scheduling.md` ("How a batch is created" step 1, Known
   gaps) and the `batch-scheduling-ux.md` line quoted above.

## Trade-offs to accept

- Scans happen at upload, before the creator commits. The post editor already works this way (it
  creates the post first), but a 500-file batch that is abandoned now costs 500 scans where it cost
  none.
- Moderation runs on images that may never be posted. That includes auto-block notices and review
  queue entries. The post editor's abandoned drafts behave the same way.
- The draft becomes server-backed: on another device the rows exist but the draft is empty. The
  sweep covers this.
