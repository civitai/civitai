# Post publishedAt bump prevention

## Problem

A post owner could bump their posts to the top of feeds by:

1. Unpublishing the post's parent Model/Version (nulls `Post.publishedAt`
   and stashes the original date as `Post.metadata.prevPublishedAt`).
2. Opening the post directly and picking a new `publishedAt` (future or
   "now").
3. Waiting for the date to pass — post resurfaces as if freshly published.

The raw SQL guard in `updatePost` accepted the NULL→future transition
without consulting the `prevPublishedAt` stash, so the bump succeeded and
the stash was left dangling on the row.

Symptom signature in the wild: a post with `publishedAt` set to a future
date AND `metadata.prevPublishedAt` set to a past date, with the parent
MV/Model still in `Unpublished` status.

## Invariant

**`Post.publishedAt` is write-once after first publish.** Re-publishing a
previously-published post always restores the original date and strips the
stash. The user cannot pick a new date for a post that was already public.

This matches how the parent Model/Version republish paths already treated
the attached Post rows — we just enforce it through the direct post-edit
path too, and through `publishPrivateModel`.

## Write sites that touch `Post.publishedAt`

| Direction | Path | File | Honors stash? |
|---|---|---|---|
| republish | `publishModelVersionById` post fanout | `mv.service.ts` | ✅ |
| republish | `publishModelById` post fanout | `model.service.ts` | ✅ |
| republish | Scheduled-publish cron | `jobs/process-scheduled-publishing.ts` | ✅ |
| republish | `updatePost` | `post.service.ts` | ✅ (this PR) |
| republish | `publishPrivateModel(publishVersions:true)` | `model.service.ts` | ✅ (this PR) |
| republish | `republish-orphaned-drafts` admin sweep | `temp/republish-orphaned-drafts.ts` | n/a (drafts only) |
| unpublish | `unpublishModelVersionById` | `mv.service.ts` | n/a (writes stash) |
| unpublish | `unpublishModelById` | `model.service.ts` | n/a (writes stash) |
| unpublish | OD/violation unpublish-all | `user.service.ts` | n/a (writes stash) |
| unpublish | `publishPrivateModel(publishVersions:false)` | `model.service.ts` | nulls without stashing (out of scope — no Public→Private user path exists) |

User-facing Public→Private flip doesn't exist; mod-only
`updateAvailability` doesn't touch `publishedAt`. The
`publishPrivateModel(false)` no-stash path is reachable but only from
already-private state, so dropping the original date there isn't a bump
vector.

## Changes in this PR

| File | Change |
|---|---|
| `src/server/services/post.service.ts` | `updatePost` raw SQL → CASE-restore from `prevPublishedAt` + strip stash + RETURNING; new `getPostUnpublishContext` JOIN derives 5 fields on `getPostDetail` when `publishedAt` is null |
| `src/server/services/model.service.ts` | `publishPrivateModel(true)` raw SQL → same CASE pattern |
| `src/components/Post/Detail/PostDetail.tsx` | "Post unpublished" alert at top of content column, visible to owner/mod when `wasPublished && !publishedAt`; link to parent model |
| `src/components/Post/EditV2/PostEditSidebar.tsx` | Restore-only state (no Publish/Schedule buttons) when `isUnpublishedByParent`; View Post button no longer gated by `publishedAt`; same alert + link |
| `src/components/Model/ModelVersions/ModelVersionDetails.tsx` | CTA toggles `Publish` ↔ `Republish` based on unpublished status; Schedule (clock) button hidden once unpublished |
| `src/pages/api/admin/temp/clamp-publishedat-bumps.ts` | Op 3 gated on `publishedAt <= NOW()` to skip scheduled-future posts; STASH keys renamed |

## Selector design

`getPostDetail` derives 5 fields server-side from `Post.metadata` and a
JOIN to MV/Model:

| Field | Source |
|---|---|
| `wasPublished` | `metadata.prevPublishedAt IS NOT NULL` |
| `unpublishedAt` | `metadata.unpublishedAt` |
| `unpublishedBy` | `metadata.unpublishedBy` |
| `parentModelId` | `ModelVersion.modelId` (used to build the parent-model link) |
| (reason intentionally not surfaced) | — see note below |

The unpublish-context JOIN is only run when `post.publishedAt IS NULL` —
the hot path for public reads skips it entirely.

`unpublishedReason` + `customMessage` live on the parent MV/Model meta
and are intentionally NOT mirrored onto the post. Model-level reasons
like `insufficient-description` don't always map onto the post itself
(we don't enforce a minimum post description, for example), so the post
alert just links back to the parent model where the reason is shown in
its proper context.

## UI behavior matrix

PostEditSidebar:

| State | Buttons rendered |
|---|---|
| Fresh draft (no `publishedAt`, no stash) | Publish + Schedule |
| Scheduled future (no stash) | Share + Reschedule |
| Currently public | Share |
| `wasPublished && !publishedAt` (parent unpublished) | None — alert + link only |

PostDetail:

| Viewer | State | Alert? |
|---|---|---|
| Owner / Mod | `wasPublished && !publishedAt` | Yes — top of content column |
| Anyone else | any | No |
| Owner / Mod | currently public | No |

ModelVersionDetails:

| Version + Model status | CTA | Schedule button |
|---|---|---|
| Draft / Scheduled | `Publish this version` | Visible |
| Unpublished / UnpublishedViolation | `Republish this version` | Hidden |

## Data cleanup: orphan stash rows

The clamp migration's Op 3 intentionally **skips** posts in the
`publishedAt > NOW() AND prevPublishedAt IS NOT NULL` band so we don't
surface them by clamping. After the PR-1 deploy, hand-fix any orphans
left over from the loophole:

```sql
-- Discover affected rows
SELECT id FROM "Post"
WHERE metadata->>'prevPublishedAt' IS NOT NULL
  AND "publishedAt" IS NOT NULL
  AND "publishedAt" > NOW();

-- For each row, drop the dangling stash. publishedAt stays untouched.
UPDATE "Post"
SET metadata = metadata - 'prevPublishedAt'
                       - 'unpublishedAt'
                       - 'unpublishedBy'
WHERE id = <orphan_post_id>;
```

Rationale for hand-fix over a script op: the affected set is single-digit;
a script Op + matching rollback + STASH namespace + payload field is
~80 lines for a one-shot — too much code for too few rows.

## Deploy steps

1. Merge PR.
2. Run `clamp-publishedat-bumps` in preview:
   `?action=apply&dryRun=true` → verify counts.
3. Apply in preview: `?action=apply&dryRun=false`.
4. Discover + hand-fix orphan posts per the §above SQL.
5. Smoke-test: unpublish a test model, open attached post → confirm
   restore-only alert + no Schedule button; republish parent → posts
   re-publish at original date.
6. Repeat steps 2–5 in production.
