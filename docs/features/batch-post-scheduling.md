# Batch post scheduling

Creators upload up to 500 images or videos once, group them into posts, apply shared metadata and a
schedule, and the server creates every post already dated. The planner (`<civitai-post-planner>`)
then shows and moves what was scheduled. Plans: `docs/batch-scheduling-plan.md` (master),
`docs/batch-scheduling-ux.md` (UX), `docs/batch-scheduling-phase1-tech.md` (composer),
`docs/batch-scheduling-planner-element.md` (planner).

## Key files

| File                                                | Purpose                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/civitai-shared/src/post-scheduling.ts`    | Window and batch constants, schedule generators, jitter, `validateBatchSchedule`, `getPostScheduleScope`; shared by the main app, the element and Creator Studio                                                                                                                                                                                 |
| `src/server/services/post-batch.service.ts`         | `persistBatchMedia`, `getBatchMediaStatus`, `removeBatchMedia` (the composer's postless draft rows), `validateBatchSchedule`, `scheduleBatch` (one chunk of posts per call, compensating delete on failure)                                                                                                                                      |
| `src/server/jobs/batch-draft-images.ts`             | `batch-draft-images-cleanup` (daily, prod only): deletes draft rows that were never scheduled after `BATCH_DRAFT_RETENTION_DAYS` (7), files included; respects the same holds as other image cleanup. Needs `Image_batchDraft_createdAt_idx` (migration `20261022120000_image_batch_draft_idx`, applied by hand) before its first production run |
| `src/server/services/post-planner.service.ts`       | Planner reads and moves (`getScheduledPosts`, `getPlannerPostDetail`, `reschedulePlannerPost`, `unschedulePlannerPosts`, `shiftPlannerPosts`)                                                                                                                                                                                                    |
| `src/server/routers/post.router.ts`                 | `post.persistBatchMedia`, `post.getBatchMediaStatus`, `post.removeBatchMedia`, `post.validateBatchSchedule`, `post.scheduleBatch`, `post.getScheduled`, `post.getPlannerDetail`, `post.reschedule`, `post.publishNow`, `post.unschedule`, `post.shiftSchedule`                                                                                   |
| `src/pages/api/v1/posts/planner/[action].ts`        | REST twins of the planner procedures for Creator Studio, table-driven by `@civitai/post-planner/contract`                                                                                                                                                                                                                                        |
| `src/components/Post/Batch/`                        | The `/posts/batch` composer: media grid, shared metadata, schedule builder, summary rail, review table, progress modal                                                                                                                                                                                                                           |
| `src/components/Post/Batch/batch-composer.draft.ts` | The composer's draft in IndexedDB (`idb-keyval`, one per user): completed uploads with their metadata, grouping, shared settings, promoted version and schedule; cleared when every post is created                                                                                                                                              |
| `src/server/services/post-preset.service.ts`        | Saved presets (`getPostPresets`, `upsertPostPreset`, `deletePostPreset`; 20 per user, name unique per user); router `src/server/routers/post-preset.router.ts`                                                                                                                                                                                   |
| `src/components/Post/Batch/BatchPresets.tsx`        | Composer preset select and "Save as preset…" modal; `src/components/Post/EditV2/PostEditApplyPreset.tsx` applies tags, tools and techniques in the post editor                                                                                                                                                                                   |
| `packages/civitai-post-planner/`                    | The planner element (Lit, on `@civitai/components`), its host contract and REST backend                                                                                                                                                                                                                                                          |
| `apps/creator-studio/src/routes/(app)/calendar/`    | Creator Studio host of the planner; `routes/api/planner/[action]` proxies to the main app                                                                                                                                                                                                                                                        |

## Flags

| Flag                  | Flipt key               | Fallback  | Gates                                                                                    |
| --------------------- | ----------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `batchPostScheduling` | `batch-post-scheduling` | `['mod']` | `/posts/batch`, the five batch procedures, the model page's "Promote this model" button  |
| `postPlanner`         | `post-planner`          | `['mod']` | The planner procedures, their REST twins, Creator Studio's `/calendar`                   |
| `postPresets`         | `post-presets`          | `['mod']` | The `postPreset` procedures, the composer's preset controls, the editor's "Apply preset" |

Rollout: while a key is absent from Flipt the static fallback gives moderators the feature. Create
each key `enabled: false` with one rollout to the `moderators` segment (the `creator-promotions`
pattern, so moderators keep it once Flipt is authoritative), add the `members` segment to widen to
members, then set `enabled: true` for everyone.

## Rules every path shares

- Lead time at least `POST_MINIMUM_SCHEDULE_MINUTES` (10) and at most `POST_MAXIMUM_SCHEDULE_MONTHS`
  (3) out.
- Batch posts keep `POST_BATCH_MIN_GAP_MINUTES` (30) between each other and the creator's existing
  scheduled posts, and never land on a `:00` minute (jitter of 1 to 9 minutes, deterministic per batch
  seed), so the publish sweep never sees a burst.
- A creator's daily post limit (`getDailyPostLimit`, the same tiers as `postRateLimits`) is counted per
  UTC go-live day across existing and incoming posts. Moderators skip the cap, not the window or gap.
- A promoted version must be `Published` on a `Published` model with no `mode` (not taken down or
  archived): the model page hides "Promote this model" otherwise, the composer shows why instead of
  its sections, and `scheduleBatch` refuses the chunk.
- A batch is at most `POST_BATCH_MAX_POSTS` (200) posts and `POST_BATCH_MAX_IMAGES` (500) files; a
  `scheduleBatch` call takes at most `POST_BATCH_CHUNK_POSTS` (10) posts and
  `POST_BATCH_CHUNK_MAX_IMAGES` (60) images; the composer sends chunks sequentially, sized so the
  progress bar moves about eight times.

## How a batch is created

1. The composer uploads files to S3 through `useMediaUpload` with no post yet, then
   `post.persistBatchMedia` creates an `Image` row per finished upload with no post (`createImage`,
   stamped `metadata.batchDraft = true`), so the normal ingestion scan runs while the creator is
   still composing. `post.getBatchMediaStatus` returns each draft's `ingestion`, `nsfwLevel`,
   `blockedFor`, `needsReview`, `minor` and `poi` so the grid can show the rating before submit; an
   id it omits is no longer the caller's postless draft and the composer drops it.
   `post.removeBatchMedia` deletes a draft and its file. A postless row is visible only to its owner
   and never indexed. Every edit is saved to the browser's IndexedDB draft, so a reload brings the
   uploads back by their image ids (thumbnails are served through `EdgeMedia`, never the local
   blob URL, which the upload hook revokes on completion). A version picked in the composer or
   arriving in the query supplies the `{model}` / `{version}` title tokens. A schedule that already
   started comes back at the defaults.
   On the client (`useBatchMediaPersist`, `useBatchScanStatus`): finished uploads are persisted in
   chunks of 10 after a 300 ms lull, and each grid entry gets its `imageId`; a call that fails
   marks its uploads failed in the grid (retry re-persists the same keys, nothing is uploaded
   twice) and keeps them out of the plan. The status query is polled every 5 s while any scan is
   `Pending`, every 15 s after three minutes, and refetched at once when the
   `ImageIngestionStatus` signal names one of the batch's ids; the thumb shows the
   `BrowsingLevelBadge` once `nsfwLevel` is set, a "Scanning" chip while pending and "Scan failed"
   on `Error`, and the summary rail counts per level ("12 PG · 3 PG-13 · 1 R") and "N still
   scanning". A `Blocked` row is ringed red, left out of every post and counted as "N blocked and
   won't be posted". Scheduling does not wait for pending scans (the editor publishes pending
   images too); the confirm dialog says how many are still scanning. Removing a thumb calls
   `post.removeBatchMedia` best effort. The draft stores only entries with an `imageId`; the first
   status fetch after a reload drops any id the server no longer answers.
2. The composer previews the schedule with the shared validator against `post.getScheduled`, then
   asks `post.validateBatchSchedule` for the authoritative answer. Review stays disabled while either
   reports an issue.
3. Each chunk re-validates its own dates on the primary, checks the promoted model version is
   usable and every listed resource is viewable, then per post: `createPostHandler`, adoption of
   the listed draft rows in order (`postId` and `index` set only where the row is still the
   caller's postless draft, marker cleared; a short count refuses the post), `createImageResources`
   per image (also run at persist time, so the scan sees the image's resources), the post's NSFW
   level and caches, tools and techniques, then `updatePostHandler` with the date so the normal
   publish path (anti-bump guard, reindex, tracking, rewards) runs. A failure at post _k_ deletes
   post _k_, hands its images back to the draft (`postId` nulled, marker restored, rows kept) and
   returns `{ created, failedAt, message }`; earlier posts stay complete and scheduled. Once the
   chunk's posts are scheduled, the batch's `resourceIds` are listed once per chunk on every image
   of those posts through the editor's manual-resource path (`addResourceToPostImage`: per-image
   cap, on-site generations skipped, the promoted version omitted), and an already-scanned image
   whose resources adoption changed is scanned again. If that step fails, every post this call
   created is discarded the same way and `failedAt` is the first of them. The composer stops and
   shows what was created.
4. Scheduled posts go live through the existing publish sweep; nothing new runs on a timer.

## How the planner moves posts

- A post on a scheduled model release moves with the release: `reschedulePlannerPost` runs the real
  `model.publish` / `modelVersion.publish` procedures by scope, so their guards apply, and refuses when
  the UI's `expectedScope` differs from the server's (a stale calendar cannot turn a chip drop into a
  release move).
- Standalone posts move through `updatePost`; unschedule and shift are single batched updates that
  only touch the caller's still-future posts.
- The planner never renders stored HTML: post descriptions come back as plain text.

## Known gaps

- Batch posts are counted against the daily limit in the database by go-live day, while ordinary
  creates count in Redis at creation time; the two can add up to one tier size on the same day.
- A draft row the composer never schedules stays postless until `batch-draft-images-cleanup`
  deletes it, with its file, after `BATCH_DRAFT_RETENTION_DAYS` (7); a file whose
  `persistBatchMedia` call never happened leaves an S3 key with no row. The draft is per browser:
  another device starts empty, and a failed or blocked upload is not in it.
- Weekday/time-slot schedules in the planner are planned, not built.
- A preset stores resource display names at save time, so a renamed or deleted model version keeps
  its old chip until the preset is re-saved; the post editor applies no resources from a preset.
