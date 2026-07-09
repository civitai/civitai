# Article Rating Review — single-action card

**Date:** 2026-06-25
**Branch:** `feat/article-rating-review-single-action`

## Problem

The moderator article-rating-review card (`src/pages/moderator/article-rating-review.tsx` →
`ArticleRatingReviewCard.tsx`) exposes a level selector plus two buttons (**Approve** / **Reject**).
When the mod-selected level equals the system's current level, "Approve as X" and "Reject" produce
the same visible rating, differing only in (a) whether an override lock is set and (b) which
notification fires. Mods read the two buttons as redundant — confusing.

Quote: *"if the user suggest PG for their R-rated article... And then I press R, I can either approve
as R or reject... Both essentially do the same thing I guess? But probably send different
notifications?"*

## Decision

Collapse to a **single submit action**. Every resolution pins (overrides) the article at the
mod-selected level. Status and notification are **derived** from selected-vs-suggested level.

- Mod picks one level — segmented control with **no default**. Submit disabled until a pick.
- Submit always runs the override/pin write (today's `Actioned` branch): sets
  `moderatorNsfwLevel = nsfwLevel = appliedLevel`, snapshots `moderatorNsfwLevelBasis`, locks
  `userNsfwLevel`.
- **Server derives status** (authoritative, not client-supplied):
  - `appliedLevel === suggestedLevel` → `Actioned` (dashboard "Approved") → `approved` notification.
  - `appliedLevel !== suggestedLevel` → `Unactioned` (dashboard "Rejected") → `rejected` notification.
- Button label derives client-side: `Approve as {level}` when pick == owner suggestion, else
  `Set rating to {level}`.

Dashboard `Pending / Approved / Rejected` filters + counts are unchanged structurally; their meaning
shifts to "was the owner's suggestion granted?" rather than "did we touch the article?".

## Changes by file

| File | Change |
|------|--------|
| `src/server/schema/article.schema.ts` | `resolveArticleRatingReviewSchema`: drop `status`, make `appliedLevel` required (positive int), remove the `.refine`. |
| `src/server/services/article.service.ts` (`resolveArticleRatingReview`) | Input `{ reviewId, appliedLevel, modComment, moderatorId }`. Read `suggestedLevel` in the txn. **Always** run the override/pin write. Derive `status` from `appliedLevel === suggestedLevel`. Branch notification on derived status; pass `appliedLevel` into the rejected notification details. Return derived `status`. |
| `src/server/notifications/article-rating-review.notifications.ts` | Reword the `rejected` `prepareMessage` — a level is now applied, so: `Your rating dispute on "{title}" was reviewed — a moderator set the rating to {appliedLevel}.` Update details type (`appliedLevel` instead of/in addition to `currentLevel`). |
| `src/server/routers/article.router.ts` | Pass-through; tracking still receives derived `status` + `appliedLevel`. |
| `src/components/Article/ArticleRatingReviewCard.tsx` | Empty-default segmented control; single Submit (disabled until pick + while pending); derived label; one `handleResolve`; update helper text; remove the dual Approve/Reject buttons + `handleApprove`/`handleDismiss`. |
| `src/pages/moderator/article-rating-review.tsx` | No logic change. (Optional tooltip clarifying Approved = suggestion granted / Rejected = overrode differently — skip unless trivial.) |

## Behavior shifts (intended; documented)

1. **Reject now pins.** Previously `Unactioned` left the rating *floating* (no override). Now it sets
   an override + basis, so the article won't auto-lower until a mod clears it, and a future
   down-direction re-dispute routes through `evaluateAutoApproveGate` gate #6 (`derived < basis`)
   instead of auto-approving freely on rescan. Direct consequence of "always pin".
2. **`status` no longer implies "override exists".** Both resolution paths now set the override;
   `status` only encodes "was the owner's suggestion granted". Verified the only `status='Actioned'`
   DB predicate near this code is on `Report` (NSFW report), not `ArticleRatingReview` — re-grep
   during implementation to confirm nothing else keys off review status as an override proxy.

## Out of scope

- No change to the auto-approve / re-dispute helper logic itself.
- No change to dispute creation (`createArticleRatingReview`).
- No backfill of historical `Unactioned` rows (they remain unpinned; only new resolutions pin).
