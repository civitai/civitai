# Article Rating Dispute

How creators contest an article's auto-computed NSFW rating, and how moderators (or the system) resolve it.

## Why it exists

An article's `nsfwLevel` is rolled up by `updateArticleNsfwLevels()` as the **MAX** of its cover image, its content images, and a moderation floor. A technical guide with a PG cover and title but a couple of R/X demo images gets shoved entirely to `.red`. Before this feature the only re-rating path was a Freshdesk ticket → manual DB fix, which didn't scale.

The dispute flow lets the owner formally request a lower rating, routes it to a moderator dashboard, and **auto-approves** the safe cases the rescan already validates so mods only see the ones that need human judgment.

Feature flag: `articleRatingDispute` (Flipt key `article-rating-dispute`, `availability: ['user']`). Gates both the owner UI and the mod dashboard route.

## Data model

`Article` (`prisma/schema.full.prisma`) carries the rating fields:

| Field | Meaning |
|-------|---------|
| `nsfwLevel` | System-computed effective level (MAX of cover + content + floor, unless an override pins it). |
| `userNsfwLevel` | Owner's declared level. |
| `moderatorNsfwLevel` | Nullable override that wins over the derivation. |
| `moderatorNsfwLevelBasis` | Content-derived level captured **when the override was placed**. Powers the auto-approve "content genuinely dropped" check. |
| `lockedProperties` | `userNsfwLevel` is pushed here while an override is active. |

`ArticleRatingReview` is the dispute row (one per submission):

- `currentLevel` — system level snapshot at submission.
- `suggestedLevel` — owner's proposed level.
- `appliedLevel` — what the resolver actually set (null until resolved).
- `userComment` / `modComment`.
- `status` — Prisma `ReportStatus`: `Pending | Actioned | Unactioned`. (`Actioned` = approved, `Unactioned` = declined. UI may label these "Approved"/"Declined".)
- `resolvedBy` — moderator userId, **or `constants.system.userId` to mark an auto-approval**.

A **partial unique index** `ArticleRatingReview_pending_per_article` (`WHERE status = 'Pending'`) enforces at most one open dispute per article and serializes concurrent submissions at the DB. Migration: `20260522120000_article_rating_review`.

## Lifecycle

```
owner submits dispute ──► evaluateAutoApproveGate
                              │
              eligible ───────┼─────── not eligible
                 │                          │
        insert Pending,                insert Pending
        promote to Actioned            (mod queue)
        (race-safe), clear                  │
        override, recompute        ┌────────┴─────────┐
                 │              mod approves      mod dismisses
                 │              (Actioned)        (Unactioned)
                 │                  │                 │
                 └────────────► notify owner ◄────────┘
```

A Pending dispute that was blocked only by an in-progress scan can also auto-resolve later — see the scan-completion hook.

## Service layer (`src/server/services/article.service.ts`)

- **`createArticleRatingReview`** — owner entry point. Enforces, in order: ownership (checked at the service layer, not router middleware), rate limit (3/day/user, mods bypass; Redis key `article:nsfw-review-rate:<userId>`), no existing Pending row, and the re-edit gate (`article.updatedAt > lastReview.resolvedAt`). Then evaluates the auto-approve gate; eligible → insert Pending **then** promote (see below); ineligible → insert Pending for the mod queue.
- **`getArticleRatingReviewForOwner`** — drives the owner's button state ("Request rating review" / "Review pending" / "Last review approved/declined on …") and the re-submit gate.
- **`getArticleRatingReviews`** — paginated mod dashboard feed (defaults to Pending, cursor on `id`).
- **`resolveArticleRatingReview`** — mod approve/dismiss. Approve writes `moderatorNsfwLevel = appliedLevel`, locks `userNsfwLevel`, snapshots `moderatorNsfwLevelBasis`, and recomputes. Dismiss closes the row with no article mutation. State transition is a status-guarded `updateMany` so two racing mods can't double-resolve (loser gets `NOT_FOUND`).

## Auto-approve (`src/server/services/article-rating-review.helpers.ts`)

`evaluateAutoApproveGate` decides whether a `(suggestedLevel, article)` pair can skip the mod queue. **All** conditions must hold:

1. **Down-direction only** — `suggestedLevel < article.nsfwLevel`. Up-disputes always go to a mod.
2. **Override active** — `moderatorNsfwLevel != null`. Without an override the recompute already self-corrects on edit, so there's nothing to clear.
2b. **Not a TOS pin** — `moderatorNsfwLevel != Blocked`. A Blocked override is never auto-cleared by an owner dispute; unblocking is a moderator action.
3. **Clean scan** — article `ingestion = Scanned`, cover image Scanned, and no content image in Pending/Rescan/PendingManualAssignment/Blocked/Error/NotFound.
4. **Published** — `status = Published` (not `UnpublishedViolation`).
5. **Content agrees** — `derived <= suggestedLevel`, where `derived = GREATEST(cover, max(content images), moderation floor)` via `computeArticleDerivedNsfwLevel`. `userNsfwLevel` is deliberately ignored (it's locked-stale under an override).
6. **Content genuinely dropped** — `basis != null && derived < basis`. The basis is the content level captured when the override was set. If `derived >= basis` the images haven't moved, so the override is encoding human judgment the scanners can't reproduce (text nuance, context) and must **not** be auto-erased. A null basis (legacy override) fails closed → mod queue.

On eligibility, the submission path inserts the review as **Pending first** (the partial unique index serializes concurrent submissions; the loser gets `P2002` → 400) then promotes it via the race-safe `autoResolveArticleRatingReview({ mode: 'resolve-existing' })`. The promotion, in one `dbWrite.$transaction`:

1. Set review `status = Actioned`, `appliedLevel = suggestedLevel`, `resolvedBy = constants.system.userId`.
2. Clear `moderatorNsfwLevel` **and** `moderatorNsfwLevelBasis` (override gone → its basis is meaningless), set `userNsfwLevel = suggestedLevel`, unlock `userNsfwLevel`.
3. `updateArticleNsfwLevels()` — with the override null, effective = `GREATEST(userNsfwLevel, derived, floor)`; gate #5 guaranteed `derived <= suggested`, so it settles at `suggestedLevel`.

Post-commit (fire-and-forget): search-index update + owner notification. Auto-approval reuses the same `article-rating-review-approved` notification as a manual approval — the owner doesn't need to know it was automated. `resolvedBy === system.userId` is the audit signal; a structured `logToAxiom` line records each auto-approve.

### Scan-completion retry

`maybeAutoResolveDisputeAfterScan` is wired into `dispatchArticleIngestionPostCommit`, so when an owner disputes during an in-flight rescan (gate #3 fails → Pending) and the scan later settles clean, the gate is re-evaluated and the Pending row auto-resolves. Failures here are caught and never roll back ingestion.

### Override-basis re-stamping

`shouldRestampOverrideBasis` re-snapshots `moderatorNsfwLevelBasis` on **every** moderator save that asserts a non-null override (even an unchanged re-affirm), not just when the value changes. This keeps the basis aligned with the mod's most recent intent so a re-affirmed above-images override can't later be auto-cleared against a stale snapshot. Re-stamping is always safe — it can only make a future auto-approve more conservative.

## Notifications

Both in `NotificationCategory.System`, sent from `resolveArticleRatingReview` / the auto-approve path:

- `article-rating-review-approved` — mod (or system) applied a new level.
- `article-rating-review-rejected` — dispute declined.

## UI

- **Owner — article detail** (`src/pages/articles/[id]/[[...slug]].tsx`): owner-only effective-rating chip + "Request rating review" button, both gated on a shared `isOwner` check and the feature flag. Button opens the dispute modal (level select + 500-char comment), registered in `dialog-registry2.ts`.
- **Owner — edit flow**: when `moderatorNsfwLevel != null` and the editor isn't a mod, a **pre-submit** confirm warns that saving triggers a rescan that can reset the rating. (Pre-submit, not a post-response flag, because the rescan is destructive and the owner needs the choice before the mutation fires.)
- **Mod dashboard** (`src/pages/moderator/article-rating-review.tsx`): infinite list of `ArticleRatingReviewCard`s (cover, title, owner, System/Suggested/Applied chips, comment, level segmented control, Approve/Dismiss).

## Observability

`ctx.track` emits `articleRatingReview` (submit) and `articleRatingReviewResolved` (resolve) ClickHouse events from the **router** layer (`.catch()`-swallowed so tracking can't fail the mutation). The CH tables `articleRatingReviews` / `articleRatingReviewsResolved` must exist before events land.

## Known follow-ups

- **Re-edit gate accepts cosmetic edits** — a fresh dispute is allowed on any `updatedAt` bump. Bounded by the 3/day rate limit; tighten to a scan-timestamp comparison only if spam appears.
- **Stale Pending with no override** — a no-override dispute can leave a lingering Pending row after a content edit lowers the live rating. Queue noise only; the live recompute already shows the lower rating.
