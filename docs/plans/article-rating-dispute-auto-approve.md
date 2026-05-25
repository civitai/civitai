# Article Rating Dispute — Auto-Approve Path

## Problem

When a moderator approves a rating dispute with an applied level (e.g. `R`), they set `Article.moderatorNsfwLevel` and add `userNsfwLevel` to `Article.lockedProperties`. The COALESCE in `updateArticleNsfwLevels` pins `nsfwLevel` to the override regardless of subsequent content rescans.

If the owner later edits the article and lowers its actual content (cover + content images now scan as `PG`), the recompute still resolves to the override (`R`). The only ways to drop the rating today are:

1. A moderator manually clears `moderatorNsfwLevel`, or
2. The owner files a new dispute and a moderator manually approves it again.

Both require a manual mod action, and the mod has no signal that the override has drifted from the underlying content.

## Goals

- Reduce manual mod load on disputes the rescan already validates.
- Never lower the effective rating below what real content + floor support.
- Preserve mod review for the cases that genuinely need a human (level raises, scan failures, repeat patterns).

## Non-goals

- No changes to the initial dispute submission UX (modal, rate limit, re-edit gate stay as-is).
- No changes to mod approval/dismiss paths.
- No trust dampener / repeat-offender logic in v1 (revisit if abuse appears).

## Design

### 1. Auto-approve at dispute submission

In `createArticleRatingReview` (`src/server/services/article.service.ts:2287`), after all existing validation (ownership, rate limit, no Pending, re-edit gate), evaluate an auto-approve gate. If it passes, write `status=Actioned` directly instead of `Pending` and run the same article-mutation side effects as the manual Actioned path.

#### Gate (all must hold)

1. **Direction**: `suggestedLevel < article.nsfwLevel` (current effective). Up-disputes always go to mod.
2. **Override active**: `article.moderatorNsfwLevel != null`. Without an override, the recompute already self-corrects on edit — no dispute is needed and we shouldn't create a fake auto-approval row for ranking metrics.
3. **Scan clean**:
   - `article.ingestion = 'Scanned'`
   - cover image `ingestion = 'Scanned'`
   - no content images in `Pending` / `Blocked` / `Error` state
4. **Article state**: `article.status = 'Published'` AND `article.status != 'UnpublishedViolation'`.
5. **Derived would land at or below suggested**:
   ```
   derived = GREATEST(
     cover.nsfwLevel,
     max(content_image.nsfwLevel),  -- across linked, non-orphaned images
     moderationFloor                  -- same source the recompute uses
   )
   ```
   Note: we deliberately ignore `userNsfwLevel` in the derived check because it is locked-stale from before the override. After auto-approve we will overwrite it with `suggestedLevel`.
   
   Pass condition: `derived <= suggestedLevel`.

If any condition fails → fall through to the normal Pending insert. Owner gets the modal feedback as if they submitted a normal dispute; mod sees it in the queue.

#### Auto-approve transaction

Mirrors the existing `Actioned` branch of `resolveArticleRatingReview` (`:2551`), in a single `dbWrite.$transaction`:

```ts
1. Insert ArticleRatingReview {
     articleId, userId,
     currentLevel: article.nsfwLevel,    // R (override pre-clear)
     suggestedLevel,
     userComment,
     status: ReportStatus.Actioned,
     appliedLevel: suggestedLevel,
     resolvedAt: new Date(),
     resolvedBy: constants.system.userId,  // signals auto-approval in audit
     modComment: 'Auto-approved: rescan matched requested rating',
   }

2. Update Article {
     moderatorNsfwLevel: null,            // release override
     userNsfwLevel: suggestedLevel,       // owner's intent now anchors
     lockedProperties: remove('userNsfwLevel'),
   }

3. updateArticleNsfwLevels([articleId], tx)
   // With override null, recompute = GREATEST(userNsfwLevel=suggested, derived).
   // Gate #5 ensured derived <= suggested, so effective = suggested.
```

Post-commit (outside the transaction, fire-and-forget with `handleLogError`):

```ts
- articlesSearchIndex.queueUpdate([{ id: articleId, action: Update }])
- createNotification({
    userId: ownerUserId,
    type: 'article-rating-review-approved',
    key: `article-rating-review-approved:${reviewId}`,
    details: { articleId, articleTitle, previousLevel, newLevel, modComment: null },
  })
  // Same type/copy as mod approval — owner doesn't need to know it was automated.
- Skip trackModActivity. resolvedBy === constants.system.userId is the audit signal.
```

Returns the same shape as the manual path so the existing mutation handler is unchanged.

### 2. Scan-completion retry hook

Covers the case where an owner re-disputes during `ingestion=Rescan` (gate #3 fails, inserts Pending), and the scan later completes with `derived <= suggestedLevel`.

Add a step to `dispatchArticleIngestionPostCommit` (`src/server/services/article.service.ts:2079`), which already runs after every recompute commits:

```ts
async function maybeAutoResolveDisputeAfterScan(articleId: number) {
  // Only act when ingestion just settled to Scanned. The result struct
  // already returned by recomputeArticleIngestionInTx tells us this.

  const pending = await dbRead.articleRatingReview.findFirst({
    where: { articleId, status: ReportStatus.Pending },
    select: { id: true, suggestedLevel: true, userId: true, currentLevel: true },
  });
  if (!pending) return;

  const article = await dbRead.article.findUnique({
    where: { id: articleId },
    select: {
      id: true, status: true, nsfwLevel: true,
      moderatorNsfwLevel: true, title: true, ingestion: true,
    },
  });
  if (!article) return;

  // Re-evaluate gate (same predicate as dispute submission).
  const eligible = await evaluateAutoApproveGate({
    article, suggestedLevel: pending.suggestedLevel,
  });
  if (!eligible) return;

  // Reuse the auto-approve transaction. Race-safe: status-guarded
  // updateMany like resolveArticleRatingReview's Actioned path.
  await autoResolveArticleRatingReview({
    reviewId: pending.id,
    suggestedLevel: pending.suggestedLevel,
    articleId,
    ownerUserId: pending.userId,
    previousLevel: pending.currentLevel,
  });
}
```

Wire `maybeAutoResolveDisputeAfterScan(articleId)` at the end of `dispatchArticleIngestionPostCommit`. Wrap in `.catch(handleLogError(...))` — failures here must never roll back ingestion state.

### 3. Shared helpers

Refactor to share logic so the two entry points (submission + scan-completion) don't drift:

```
articleRatingReview.helpers.ts (new, co-located with article.service.ts):
  - evaluateAutoApproveGate({ article, suggestedLevel }): Promise<boolean>
      Encapsulates conditions 1–5. Reads cover + content image ingestion
      + nsfwLevels and the moderation floor.

  - autoResolveArticleRatingReview({ reviewId?, articleId, suggestedLevel,
                                     ownerUserId, previousLevel, userComment? })
      Two modes:
        - reviewId undefined → create+resolve in one shot (submission path).
        - reviewId provided   → resolve existing Pending row (scan path).
      Both share the article-mutation block.
```

Keep the existing `resolveArticleRatingReview` untouched for the mod-driven path; the new helper duplicates the article-mutation block to avoid coupling the mod path's status-guard logic with the auto path's "may also need to create the row" branching.

### 4. Notification

Reuse `article-rating-review-approved`. Same copy. `modComment` defaults to `null` from the auto path so the message reads as "rating updated from X to Y" without the auto-approve string leaking into UI.

### 5. Audit / observability

- `resolvedBy = constants.system.userId` is the canonical audit signal.
- Add a structured log line via `logToAxiom` at each auto-approve with `{ articleId, reviewId, suggestedLevel, previousOverride, derived, entryPoint: 'submission' | 'scan-completion' }` for monitoring.
- Optionally: add `ClickHouse` event so we can graph manual-vs-auto resolution ratios.

## Edge cases

- **Owner disputes during Rescan, scan never completes**: review stays Pending → mod queue handles it. Same as today.
- **Cover image swapped post-auto-approve**: any owner edit triggers `linkArticleContentImages` + `ingestion=Rescan`. After scan, `updateArticleNsfwLevels` recomputes with `override=null` — higher images raise `nsfwLevel` naturally. No exploit window.
- **Two re-disputes in flight**: partial unique index `ArticleRatingReview_pending_per_article` already prevents two Pending rows. Auto-approve at submission inserts directly as Actioned, so the unique index is not touched. If the previous dispute is still Pending, the new submission throws "review already pending" before reaching the gate.
- **Two mods race a scan-completion retry**: status-guarded `updateMany` (same pattern as `resolveArticleRatingReview`) — loser throws `NOT_FOUND`.
- **Auto-approve fails mid-flight**: notification + search index are post-commit fire-and-forget. Article mutation is the only persistence; if step 2 fails the transaction rolls back and the review row never exists.

## File / symbol touchpoints

- `src/server/services/article.service.ts`
  - `createArticleRatingReview` (`:2287`) — add gate evaluation + auto-approve branch.
  - `dispatchArticleIngestionPostCommit` (`:2079`) — append `maybeAutoResolveDisputeAfterScan`.
- `src/server/services/article-rating-review.helpers.ts` (new)
  - `evaluateAutoApproveGate`
  - `autoResolveArticleRatingReview`
- `src/server/common/constants.ts` — confirm `constants.system.userId` exists (it does per memory) and is exported where needed.
- `src/components/Article/ArticleRatingReviewModal.tsx` — no change needed. Modal calls the same `create` mutation; auto-approve returns the same shape, so the UI continues to render "approved" state from the existing `getArticleRatingReviewForOwner` query refetch.

## Complementary UX fixes

Even with auto-approve in place, two cheap UX changes close remaining gaps where auto-approve doesn't fire (gate blocks on raise, on dirty scan, or override is set but owner doesn't realize they can re-dispute).

### A. Mod approve modal hint

**Where**: `src/pages/moderator/article-rating-review.tsx` — the Approve flow modal/segmented control area.

**Change**: render a `<Text size="xs" c="dimmed">` (or `Alert`) under the level picker, visible only when "Approve as X" is the active action:

> Override locks the rating until a moderator clears it. Owner edits won't drop the rating below this level automatically.

Pure copy, zero infra. Sets mod expectation at decision time so they understand the override's stickiness without needing tribal knowledge.

### B. Owner banner on article when override is stale

**Where**: article detail page owner view — same place that surfaces the existing dispute CTA (modal trigger from `src/components/Dialog/triggers/article-rating-review.ts`).

**Trigger condition** (all true):

1. Current viewer is the article owner.
2. `article.moderatorNsfwLevel != null` (override active).
3. Underlying derived rating dropped below the override. This is the same `derived <= article.moderatorNsfwLevel` check the auto-approve gate uses, computed via the existing `getArticleRatingReviewForOwner` query (extend its return to include a `derivedRatingDroppedBelowOverride: boolean` flag).
4. `canResubmit === true` (the re-edit gate from `getArticleRatingReviewForOwner` already returns this).

**Copy**:

> Your recent edits brought this article's content down to `<derivedLabel>`, but a previous moderator decision pinned it at `<overrideLabel>`. Request a rating review and a moderator (or our system, if the scan agrees) will update the rating.

CTA: same "Request rating review" button that opens `ArticleRatingReviewModal`. Pre-fill the modal's `suggestedLevel` with the derived level so the owner doesn't have to guess.

**Why both this and auto-approve**: auto-approve fires when the owner *does* re-dispute. The banner is what makes them realize they should. Without it, an owner who edited their article and walked away never finds out the rating is stale.

**Cost**: one extra computed field on `getArticleRatingReviewForOwner` (reuse `evaluateAutoApproveGate`'s derived-rating helper), one new banner component or addition to the existing dispute-status UI. No new DB columns.

### Implementation order

1. Auto-approve at submission + scan-completion retry (this plan's core).
2. (A) Mod modal hint — ship same PR, trivial.
3. (B) Owner banner — separate PR; depends on extending `getArticleRatingReviewForOwner` and on having the derived-rating helper in place from step 1.

## Out of scope (revisit later)

- Mod-dashboard "stale override" filter — auto-approve covers the common case; remaining stale overrides should be rare. If they accumulate, add the filter then.
- Trust dampener (revoke auto-eligibility on repeat edit-up patterns).
- Owner-visible explanation of why a re-dispute was auto-approved vs. queued.

## Test plan

Co-located with `docs/plans/article-rating-dispute-test-plan.md`. Add cases:

1. **Auto-approve happy path**: override=R, scan clean, all images PG, owner disputes PG → review inserted as Actioned, override cleared, `nsfwLevel=PG`, notification fired.
2. **Block on Rescan**: same as (1) but `ingestion=Rescan` → review inserted Pending. After background scan completes with derived=PG, post-commit hook auto-resolves → final state matches (1).
3. **Block on blocked image**: derived images include one `Blocked` → review Pending; never auto-resolves (gate #3 stays false even after scan settles).
4. **Block on level raise**: override=R, owner disputes X → Pending (gate #1 fails).
5. **Block on no-override**: no `moderatorNsfwLevel` set, owner disputes lower → falls to mod queue (gate #2 fails). Today's behavior preserved.
6. **Derived exceeds suggested**: override=R, owner disputes PG, but cover image scans as R → review Pending (gate #5 fails). Mod handles.
7. **Race**: two concurrent auto-resolve attempts on the same Pending review (e.g. submission + scan completion firing near-simultaneously) → exactly one Actioned write, the other throws `NOT_FOUND` from `updateMany`.
