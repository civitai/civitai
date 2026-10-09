# Batch post scheduling

Creators upload up to 500 images or videos once, group them into posts, apply shared metadata and a
schedule, and the server creates every post already dated. The planner (`<civitai-post-planner>`)
then shows and moves what was scheduled. Plans: `docs/batch-scheduling-plan.md` (master),
`docs/batch-scheduling-ux.md` (UX), `docs/batch-scheduling-phase1-tech.md` (composer),
`docs/batch-scheduling-planner-element.md` (planner).

## Key files

| File                                             | Purpose                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/civitai-shared/src/post-scheduling.ts` | Window and batch constants, schedule generators, jitter, `validateBatchSchedule`, `getPostScheduleScope`; shared by the main app, the element and Creator Studio                |
| `src/server/services/post-batch.service.ts`      | `validateBatchSchedule`, `scheduleBatch` (one chunk of posts per call, compensating delete on failure)                                                                          |
| `src/server/services/post-planner.service.ts`    | Planner reads and moves (`getScheduledPosts`, `getPlannerPostDetail`, `reschedulePlannerPost`, `unschedulePlannerPosts`, `shiftPlannerPosts`)                                   |
| `src/server/routers/post.router.ts`              | `post.validateBatchSchedule`, `post.scheduleBatch`, `post.getScheduled`, `post.getPlannerDetail`, `post.reschedule`, `post.publishNow`, `post.unschedule`, `post.shiftSchedule` |
| `src/pages/api/v1/posts/planner/[action].ts`     | REST twins of the planner procedures for Creator Studio, table-driven by `@civitai/post-planner/contract`                                                                       |
| `src/components/Post/Batch/`                     | The `/posts/batch` composer: media grid, shared metadata, schedule builder, summary rail, review table, progress modal                                                          |
| `packages/civitai-post-planner/`                 | The planner element (Lit, on `@civitai/components`), its host contract and REST backend                                                                                         |
| `apps/creator-studio/src/routes/(app)/calendar/` | Creator Studio host of the planner; `routes/api/planner/[action]` proxies to the main app                                                                                       |

## Flags

| Flag                  | Flipt key               | Fallback  | Gates                                                                                  |
| --------------------- | ----------------------- | --------- | -------------------------------------------------------------------------------------- |
| `batchPostScheduling` | `batch-post-scheduling` | `['mod']` | `/posts/batch`, the two batch procedures, the model page's "Promote this model" button |
| `postPlanner`         | `post-planner`          | `['mod']` | The planner procedures, their REST twins, Creator Studio's `/calendar`                 |

Rollout: create the Flipt flags, start with a rule for the `isMember` segment, widen to 100%.

## Rules every path shares

- Lead time at least `POST_MINIMUM_SCHEDULE_MINUTES` (10) and at most `POST_MAXIMUM_SCHEDULE_MONTHS`
  (3) out.
- Batch posts keep `POST_BATCH_MIN_GAP_MINUTES` (30) between each other and the creator's existing
  scheduled posts, and never land on a `:00` minute (jitter of 1 to 9 minutes, deterministic per batch
  seed), so the publish sweep never sees a burst.
- A creator's daily post limit (`getDailyPostLimit`, the same tiers as `postRateLimits`) is counted per
  UTC go-live day across existing and incoming posts. Moderators skip the cap, not the window or gap.
- A batch is at most `POST_BATCH_MAX_POSTS` (200) posts and `POST_BATCH_MAX_IMAGES` (500) files; a
  `scheduleBatch` call takes at most `POST_BATCH_CHUNK_POSTS` (10) posts and
  `POST_BATCH_CHUNK_MAX_IMAGES` (60) images; the composer sends chunks sequentially, sized so the
  progress bar moves about eight times.

## How a batch is created

1. The composer uploads files to S3 through `useMediaUpload` with no post yet. Nothing exists on the
   server until the creator confirms the review screen.
2. The composer previews the schedule with the shared validator against `post.getScheduled`, then
   asks `post.validateBatchSchedule` for the authoritative answer. Review stays disabled while either
   reports an issue.
3. Each chunk re-validates its own dates on the primary, checks the promoted model version is usable,
   then per post: `createPostHandler`, `addPostImage` per file, tools and techniques, then
   `updatePostHandler` with the date so the normal publish path (anti-bump guard, reindex, tracking,
   rewards) runs. A failure at post _k_ deletes post _k_ and returns `{ created, failedAt, message }`;
   earlier posts stay complete and scheduled. The composer stops and shows what was created.
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
- Files uploaded and then abandoned in the composer leave S3 keys with no `Image` row.
- Weekday/time-slot schedules, Week and Day hour grids in the planner, and saved presets are planned,
  not built.
