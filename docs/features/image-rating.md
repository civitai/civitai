# Image Rating and Visibility

How an image gets its `nsfwLevel`, how it is routed to review, and when the public can see it. This is the
definitive rule set; if code and this doc disagree, one of them is a bug — fix whichever is wrong in the same
PR.

For the `nsfwLevel` bitflag itself and browsing-level filtering, see [nsfw-filtering.md](./nsfw-filtering.md).

## The fields

| Field                      | Meaning                                                                                                                                                                                                                      | Written by                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ingestion`                | Where the image is in the scan lifecycle. `Pending` → `Scanned` / `Blocked` / `Error`; `Rescan` re-enters the scan. `NotFound` means no media behind the row. `PendingManualAssignment` skips the scan (judged collections). | Upload, scan verdict, retry cron, moderators                   |
| `nsfwLevel`                | The rating. `0` = unrated. Derived from tags unless locked.                                                                                                                                                                  | Scan, tag changes, moderators, Knights                         |
| `nsfwLevelLocked`          | A human decided the rating. Tag changes and rescans no longer move it.                                                                                                                                                       | Moderators, Knights consensus                                  |
| `metadata.nsfwLevelReason` | Why the lock was set. `KNIGHTS_VOTE_NSFW_LEVEL_REASON` marks a Knights consensus lock; anything else is a moderator.                                                                                                         | Same writers as the lock                                       |
| `needsReview`              | Which moderator queue holds the image (`poi`, `minor`, `tag`, `newUser`, `modRule`, `appeal`, …). Non-null hides it from the public.                                                                                         | Scan, tag changes, reports, moderators                         |
| `blockedFor`               | Why the image is blocked. Set together with `ingestion = Blocked`.                                                                                                                                                           | Scan, moderation rules, moderators                             |
| `scannedAt`                | When the scan completed. Feeds `sortAt`.                                                                                                                                                                                     | Scan verdict, moderator accept, ingestion-error resolve        |
| `scanJobs`                 | Scan bookkeeping: `workflowId`, `retryCount`, `error.failureClass`.                                                                                                                                                          | Scan request, scan failure                                     |
| `minor` / `poi`            | Content flags from the scan; optional feed exclusions.                                                                                                                                                                       | Scan, moderators                                               |

`nsfwLevel` is derived from tags until `nsfwLevelLocked` is set; `sortAt` is derived from these (step 8).

## Step by step

### 1. Upload

1. `createImage` inserts the row with `ingestion = Pending`, `nsfwLevel = 0`
   (`PendingManualAssignment` instead for collections whose judges apply the rating).
2. It calls `ingestImage`, which submits the scan and stamps `scanRequestedAt` and `scanJobs.workflowId`.
3. A database trigger also queues the image in `JobQueue(ImageScan)` whenever `ingestion` becomes `Pending`,
   `Rescan` or `Error`, so a lost submit is retried by the cron (step 3).

### 2. Scan verdict

The webhook `/api/webhooks/image-scan-result` runs the shared stages in `image-scan-pipeline.ts`:

1. **Tags.** The scanner's tags, plus tags computed from the prompt and tag rules, are written as automated
   tags.
2. **Rating.** `nsfwLevel` = the highest `Tag.nsfwLevel` among the image's enabled automated tags — unless
   `nsfwLevelLocked`, in which case the existing level is kept.
3. **Hard block.** A failed prompt audit on an NSFW image (or, on the legacy scanner, a blocking content
   rating) sets `ingestion = Blocked`, `nsfwLevel = Blocked` and `blockedFor`. A block overrides a lock.
4. **Review routing.** Otherwise `ingestion = Scanned`, and `needsReview` is set to the first that applies:
   `poi` → `minor` → `tag` (a Blocked-level or conditional review tag) → `newUser` (NSFW from a new account).
   The tags that triggered it are recorded in `ImageTagForReview` so the queue can show them.
5. **Moderation rules** run last and win: _Block_ blocks the image and notifies the owner, _Hold_ sets
   `needsReview = 'modRule'`, _Approve_ changes nothing.
6. **`scannedAt`** is stamped on the first scan. Later scans re-stamp it only for images under a week old,
   not on `Rescan`.
7. A scanned image with no review key is offered to the Knights rating game.

### 3. Scan failure and retry

1. A failed or unusable scan sets `ingestion = Error`, increments `scanJobs.retryCount` and records
   `scanJobs.error.failureClass` (`transient`, `unknown` or `permanent`).
2. The `ingest-images` cron (every 5 minutes) re-sends from the queue:
   - **Pending** — once the retry delay has passed. A user upload still `Pending` past the timeout is moved
     to `Error`.
   - **Error** — after an hour, while `retryCount` is under the ceiling for its failure class
     (`getImageScanRetryLimit`: transient 30, unknown 9, permanent 1).
   - **Rescan** — like Pending, capped at 9 retries; an exhausted `Rescan` returns to `Error`.
3. An image that exhausts its retries stays `Error` until a moderator acts (step 6) or it is requeued by
   setting `ingestion = Rescan` with `scanJobs.retryCount` reset. Set `scannedAt` to `createdAt` when
   requeueing old images (step 8).

### 4. Tag changes after the scan

Tags keep changing after the scan — tag votes (`apply-voted-tags`), tag rules, moderator tools.
Every write through `tagsOnImageNew.service.ts` (or its moderator-app twin, `tags-on-image.service.ts`):

1. Applies tag rules, so a rule-appended tag is treated like a written one.
2. Recomputes the rating with `update_nsfw_levels_new` (main app: only when a moderated tag changed; moderator
   app: on every write) — the highest enabled tag level, applied only to `Scanned`, unblocked, **unlocked**
   images. It can also move a scan-flagged minor image into the `minor` queue.
3. If a written, enabled Blocked-level tag leaves an unlocked, unblocked `Scanned` image at Blocked with no
   review key, sets `needsReview = 'tag'` and records the tag in `ImageTagForReview` — the same queue the scan
   uses.

### 5. Human ratings

All go through `updateImageNsfwLevel` (main app) or its moderator-app twin.

| Who                | Effect                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Moderator          | Sets `nsfwLevel`, **locks it**, records the reason and ModActivity. Does not change `ingestion` or `needsReview`.               |
| Knights consensus  | Same as a moderator, with `nsfwLevelReason = KNIGHTS_VOTE_NSFW_LEVEL_REASON`. A large down-rating escalates instead of locking. |
| Owner / other user | Only on unlocked images: records an `ImageRatingRequest` vote (owner votes weigh more). Does not change the level directly.     |

### 6. Leaving a review queue

Moderator actions clear `needsReview`:

- **Accept** — `needsReview = null`, `ingestion = Scanned`, clears `blockedFor`. From the `poi` queue it clears
  `poi`; from `minor` it may clear `minor`. Re-stamps `scannedAt` for `minor`/`poi`/`newUser` reviews (step
  8). A Blocked-level image is unlocked and re-rated from its tags, and its review tags are disabled.
- **Block** — `needsReview = null`, `ingestion = Blocked`, `nsfwLevel = Blocked`, `blockedFor = Moderated`.
- **Resolve ingestion error** — after confirming its media still exists, rates and locks an `Error` image,
  sets `ingestion = Scanned` and stamps `scannedAt = now()` (step 8).
- **Appeal** — approved sets `needsReview = null`, `blockedFor = null`, `ingestion = Scanned` and recomputes
  the rating, without clearing flags or unlocking; rejected only clears `needsReview`.

### 7. Who can see it

**Reviewed** is one rule, `imageReviewedSql` / `isImageReviewed` in `src/server/common/image-visibility.ts`.
An image is reviewed when:

1. `ingestion = Scanned`, **or**
2. its rating is locked **and** `ingestion` is not `Blocked` or `NotFound` **and**, if `ingestion = Error`,
   the lock was set by a moderator (not Knights) and the scan failure was not `permanent`.

A locked `Error` image is held to a stricter standard because its scan never ran the minor, POI and prompt
checks; a moderator looking at it stands in for those, Knights consensus does not.

Every public read path below requires **reviewed** and `needsReview IS NULL`, then adds its own filters:

| Path                                  | Also requires                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `getAllImages`                        | `acceptableMinor = false` outside collections; `nsfwLevel` non-zero and matching the browsing level             |
| `getImagesForModelVersion`            | `acceptableMinor = false`; `nsfwLevel` matching the browsing level, or `!= 0` without one                       |
| `getImage`                            | `nsfwLevel != Blocked`; post published and not private. Owners and collection managers bypass                   |
| Remix gallery host (`hostIsShowable`) | `tosViolation = false`, `nsfwLevel != Blocked`                                                                  |
| `images` search index                 | `tosViolation = false`, `minor = false`, `poi = false`, post published and neither private nor unsearchable    |
| `getHiddenImagesForUser`              | `nsfwLevel != Blocked`, `tosViolation = false`, post published and not private (or the profile cover)          |

The `metrics-images` Meilisearch feed (the main image feed) applies its own query-time filters on the fields
it indexes rather than calling `imageReviewedSql`; a change to the rule above has to be made there separately.

Owners always see their own images, including unrated and in-review ones. Moderators see everything in the
pending views.

When adding a new image read path, use `imageReviewedSql()`, or `isImageReviewed` for rows already fetched —
do not re-derive visibility from `nsfwLevel` alone.

### 8. Sort order

`sortAt = GREATEST(post.publishedAt, scannedAt, createdAt)`, recomputed by a trigger on every write to the
image (and on a post's `publishedAt` change). A first or re-stamped `scannedAt` on an old image therefore moves
it to the top of Newest.

## Key files

| Concern                            | File                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Visibility rule                    | `src/server/common/image-visibility.ts`                                                                                           |
| Scan request, human ratings, feeds | `src/server/services/image.service.ts`                                                                                            |
| Scan verdict                       | `src/server/services/image-scan-pipeline.ts`, `image-scan-result.service.ts`, `image-scanning-result.service.ts`                  |
| Failure classes                    | `src/server/services/image-scan-failure.ts`                                                                                       |
| Retry cron                         | `src/server/jobs/image-ingestion.ts`                                                                                              |
| Tag writes after the scan          | `src/server/services/tagsOnImageNew.service.ts`, `apps/moderator/src/lib/server/tags-on-image.service.ts`, `src/server/jobs/apply-voted-tags.ts` |
| Rating recompute                   | `packages/civitai-db-schema/prisma/programmability/update_nsfw_level.sql`                                                         |
| Knights                            | `src/server/services/games/new-order.service.ts`                                                                                  |
| Moderator actions                  | `apps/moderator/src/lib/server/image-moderation.service.ts`, `image-nsfw-level.ts`, `ingestion.service.ts`                        |
| `sortAt` trigger                   | `packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql`                                                       |
