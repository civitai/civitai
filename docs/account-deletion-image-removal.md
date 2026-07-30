# Account self-deletion: remove user images

**ClickUp:** [868kj32gm](https://app.clickup.com/t/868kj32gm)
**Date:** 2026-07-30
**Status:** Design approved, pending spec review

## Problem

When a user deletes their own account, `deleteUser` handles Models, Accounts, Sessions,
UserEngagements and the User row. Images and Posts are not touched at all. Every image the
user ever uploaded — including R+ content — stays live and orphaned on the platform after
the account is gone.

The gap is not only forward-looking. **74,828 accounts are already soft-deleted and still
own 7,235,873 images.**

## Decisions

### Hard delete, not soft delete

Images are removed from the database and from S3. There is no grace period and no
appeal window.

The task originally framed this as a soft-delete question, and three soft-delete levers were
evaluated and rejected:

- **`Image.ingestion = 'Blocked'`** (what the ban flow uses). Rejected. Migration
  `20260113194750_add_blocked_image_delete_job_queue` installs an
  `AFTER UPDATE OF ingestion ON "Image"` trigger that enqueues `JobQueue(BlockedImageDelete)`.
  Writing `Blocked` silently arms a 7-day hard delete — it is a countdown, not a pause. It also
  overloads moderation semantics (`blockedFor`) onto a voluntary user action.
- **`Post.availability = 'Private'`**. Rejected. It does hide content effectively (verified
  below), but it is post-granular, and post-less images are a large population. More
  decisively, it leaves the bytes on the CDN.
- **A new `Image.availability` column.** Rejected as disproportionate: a hand-applied
  migration plus a backfill of a ~100M-row table plus edits to the hottest query path in the
  repo, and it still leaves the CDN bytes reachable.

The deciding factor for all three: `getEdgeUrl` (`src/client-utils/edge-url.ts:89`) builds
`${NEXT_PUBLIC_IMAGE_LOCATION}/${url}/width=...` — a plain public origin with no signing and
no authorization. **No soft-delete option removes a saved direct CDN link.** Only
`deleteImageFromS3`, inside `deleteImages()`, does. Since the goal is preventing leaked
content, reversibility was traded away deliberately.

### Scope: every image the user owns

All ratings, all attachments. ClickUp's Option B (R+ only) is dropped — with a full hard
delete the rating filter adds branching for no benefit. No showcase carve-out. No new
user-facing toggle.

### Execution: background drain, worklist derived from `User.deletedAt`

`deleteUser` stays a fast transaction and does **not** delete images inline. A single user
can own up to 784,498 images (p99.9 is 16,906; 4,522 users hold more than 5,000). At
`deleteImages()`'s batch size of 100 that is thousands of batches — hours of work that would
time out the `user.delete` mutation and leave the account half-deleted.

Instead a new job selects images whose owner has `deletedAt IS NOT NULL`, batches them
through the existing `deleteImages()`, then deletes the user's emptied posts — the same
two-step as `src/pages/api/mod/delete-user-images.ts`.

Unlike that mod endpoint, which scopes the post delete to the posts that held the deleted
images so it cannot touch another user's posts, this job deletes **every** post the account
owns. The account is gone, so there is nothing to preserve, and a post keeps title/detail text
that the image delete would otherwise leave behind.

The worklist is paged with a persisted `deletedAt` cursor (`getJobDate`), walking newest-first
so a fresh self-deletion is honoured ahead of the backlog. The cursor advances only past users
the run finished, so one left half-drained by the per-run cap is still first in line next run.
An empty page resets the cursor to the top — accounts deleted *after* a run started sort above
a descending cursor, and that wrap is what brings them back into range.

Deriving the worklist from `User.deletedAt` rather than writing queue rows means:

- One small migration: a partial index on `User."deletedAt"`. Without it the job's driving
  query is a parallel seq scan over 12.7M users (~1.7s, ~612K buffers) every run. Still no
  schema change and no backfill.
- Idempotent and retry-safe. A crash mid-user resumes on the next tick.
- No queue state to drift out of sync with reality.
- The 7.2M-image backlog is covered by the same code path, with no separate backfill script.

Reusing `deleteImages()` brings S3 cleanup, search-index deletion, post-NSFW recompute and
cache busting for free.

### Backlog: purged, rate-limited

The job processes historical and new deletions identically, under a per-tick cap so the S3
delete volume and search-index churn stay bounded. The cap ships at 500 images/run — enough to
stay ahead of new deletions (~1.2 image-owning accounts an hour) without committing to an
unmeasured backlog rate on the deploy that turns the job on. Draining 7.2M images needs the cap
raised in Redis (`system:deleted-user-image-purge-limit`); at 25,000/run that is ~12 days.
Setting it to `0` pauses the drain. The job logs its per-run counts to Axiom so the drain is
observable.

## Consequences

These are accepted, not open questions.

- **`restoreAccount` can no longer restore images.** Models still restore through the
  ClickHouse audit path in `restoreUser`. The doc comment at
  `src/server/services/user.service.ts:1085-1095` describes what survives deletion and becomes
  wrong — it must be updated.
- **Orphaned models keep empty galleries.** With `removeModels=false`, models move to
  `userId = -1` and stay Published while their showcase images are deleted.
- **The unpublish cascade does not fire.** `reset-to-draft-without-requirements.ts:22` guards
  the no-posts branch with `AND m."userId" != -1`, and line 25 with `AND m."deletedAt" IS NULL`.
  `removeModels=false` produces the former, `removeModels=true` the latter, so self-deleted
  accounts' models are excluded either way. (This was initially flagged as a risk; verification
  showed it is not one for this flow.)
- **Deletion is not instantaneous** — it is job-tick plus drain time.
- **`SET NULL` side effects.** 13 FKs reference `Image`; none `RESTRICT`, so the raw delete is
  never blocked. But `ChallengeWinner.imageId` and `Challenge`/`ChallengeEvent.coverImageId` are
  `SET NULL`, so purging a former user's winning or cover image silently nulls those records.
  `ComicPanel.imageId` and `ComicProject.hero/coverImageId` likewise.
- **Orphan rows in FK-less tables.** Several image-related tables have no FK to `Image`, which
  is why `deleteImages()` calls `removeEntityFromAllCollections` manually. This is pre-existing
  `deleteImages()` behavior, inherited rather than introduced.
- **S3 deletion is best-effort.** `deleteImages()` drops the DB row before the S3 object, so a
  failed object delete leaves a public CDN url with no row to retry from. The failure is now
  logged (`delete-image-from-s3-failed`, with the image id and url) rather than swallowed, but
  it is not retried — recovery means replaying those log lines.

## Open items

- **Article covers.** The rule is owner-based, so an article cover image is deleted. But
  `deleteUser` does not delete articles, so a live article is left with a missing cover.
  Options: delete the user's articles too (scope growth), skip cover images (breaks the "all
  images" rule), or accept coverless articles for v1 and file a follow-up. **Recommendation:
  accept for v1, file a follow-up** — orphaned articles are the same class of gap as orphaned
  images and deserve their own ticket.
- **Rate-limit tuning.** The 500/run default is deliberately below anything that would move the
  backlog; it only keeps up with new deletions. Validate S3 delete throughput and search-index
  queue depth on the first runs, then raise `system:deleted-user-image-purge-limit` in sysRedis
  (no deploy needed) to start the backlog drain — 25,000 was the original, unmeasured estimate.
- **Backlog kill switch.** Resolved: the cap lives in sysRedis under
  `system:deleted-user-image-purge-limit`. `0` pauses the drain; an unset key falls back to the
  compiled default.

## Verified facts

Gathered during design; recorded so the plan does not re-derive them.

| Fact | Source |
|---|---|
| `Image` has no `availability` column; only `Post` does | `schema.full.prisma:1279` |
| Feeds filter `p."availability" != 'Private'` with an owner carve-out | `image.service.ts:1488`, `:3190` |
| Meilisearch filters `availability != Private`; images carry it denormalized from the post | `image.service.ts:3846`, `:2669`, `:3049` |
| `/images/:id` applies the availability filter — the page passes no `withoutPost` | `pages/images/[imageId].tsx:19` → `image.service.ts:4944` |
| `withoutPost: true` is only used for article images | `ImageDetailByProps.tsx:77` |
| CDN URLs are unsigned and unauthorized | `client-utils/edge-url.ts:89` |
| Blocked images are auto-enqueued for hard delete by a DB trigger | migration `20260113194750` |
| `remove-blocked-images` purges after 7 days | `jobs/image-ingestion.ts:479` |
| `deleteUser` touches no images or posts | `user.service.ts:1028` |
| Max images for one user: 784,498; p99.9: 16,906; 4,522 users over 5,000 | prod query |
| Already-deleted accounts: 74,828, holding 7,235,873 images | prod query |
| 13 FKs reference `Image`: 2 CASCADE, 11 SET NULL, 0 RESTRICT | prod `pg_constraint` |

## Files in scope

| File | Change |
|---|---|
| `src/server/jobs/remove-deleted-user-images.ts` | New rate-limited drain job |
| `src/server/jobs/__tests__/remove-deleted-user-images.test.ts` | Job tests |
| `src/pages/api/webhooks/run-jobs/[[...run]].ts` | Register the job (import + `jobs` array) |
| `packages/civitai-redis/src/client.ts` | `REDIS_SYS_KEYS.SYSTEM.DELETED_USER_IMAGE_PURGE_LIMIT` |
| `packages/civitai-db-schema/prisma/migrations/20260730130000_user_deleted_at_partial_index/migration.sql` | Partial index on `User."deletedAt"` (hand-applied) |
| `src/server/services/user.service.ts` | Update the `restoreUser` doc comment |
| `src/server/services/image.service.ts` | `deleteImages` reused as-is; `deleteImageFromS3` now logs its failures instead of swallowing them |
| `src/server/services/__tests__/delete-image-from-s3-logging.test.ts` | Guards that logging |

One index-only migration (hand-applied). No schema change, no UI change, no new tRPC procedure.
