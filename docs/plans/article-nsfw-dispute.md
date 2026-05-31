# Plan: Article NSFW Level Dispute Flow

**ClickUp:** [868jndtcv](https://app.clickup.com/t/868jndtcv)
**Source ticket:** Freshdesk #63834 (creator "Volnovik", userId 2938002)
**Status:** Implemented — see §12 for as-built deviations.

---

## 1. Problem

Article `nsfwLevel` is rolled up from cover + content images via `updateArticleNsfwLevels()` (per-image MAX). For technical guides that embed R/X demo images, the article gets shoved entirely to `.red` even when the cover and title are PG. Today the only path for re-rating is a Freshdesk ticket → manual fix. Doesn't scale.

## 2. Goals

1. Owner-driven dispute submission from the article detail page.
2. Mod review dashboard (pattern parallel to existing `image-rating-review`).
3. Mod decision applies via existing `Article.moderatorNsfwLevel` override; notify the owner of the outcome.
4. Public self-check guideline page so creators can pre-flight before disputing.
5. Friction on edit-after-override so creators understand a rescan will reopen the rating.

Out of scope:
- Abuse-tracking auto-rejection — instrument metrics only; no automated blocks in v1.
- Extending the flow to Models.
- Auto-syncing the guideline page to the live trigger-word list — link to it, but the page stays manually maintained for v1.

## 3. Data model

`Article` already has the override fields (`prisma/schema.full.prisma:2697`):
- `nsfwLevel` — system-computed (MAX of cover + content image levels)
- `userNsfwLevel` — owner's declared level
- `moderatorNsfwLevel` — nullable override that wins over the derivation
- `lockedProperties` — array of locked fields (existing convention: `userNsfwLevel` is locked when a mod override is active)

We only need to add a request table. Mirror `ImageRatingRequest` shape but scoped to articles. Single active dispute per article (owner-driven, not vote-based).

### New model: `ArticleRatingReview`

Add to `prisma/schema.full.prisma` (NOT the slim `schema.prisma` — see CLAUDE.md memory):

```prisma
model ArticleRatingReview {
  id                 Int          @id @default(autoincrement())
  articleId          Int
  article            Article      @relation(fields: [articleId], references: [id], onDelete: Cascade)
  userId             Int          // requesting owner
  user               User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt          DateTime     @default(now())
  resolvedAt         DateTime?
  resolvedBy         Int?         // moderator userId
  resolver           User?        @relation("ArticleRatingReviewResolver", fields: [resolvedBy], references: [id], onDelete: SetNull)
  currentLevel   Int          // snapshot at submission
  suggestedLevel Int          // owner's proposal (userNsfwLevel)
  appliedLevel   Int?         // what the mod actually set
  userComment        String?
  modComment         String?
  status             ReportStatus @default(Pending) // Pending | Actioned | Dismissed

  @@unique([articleId, status], name: "one_pending_per_article", map: "ArticleRatingReview_one_pending_idx")
  @@index([status, createdAt])
  @@index([userId])
}
```

Notes on the partial-unique:
- We want at most one `Pending` per article. The `@@unique([articleId, status])` form is overly strict (also dedupes resolved rows). Use a partial unique index via `@@index` + a separate raw migration:

```sql
CREATE UNIQUE INDEX "ArticleRatingReview_pending_per_article"
  ON "ArticleRatingReview"("articleId")
  WHERE status = 'Pending';
```

Drop the `@@unique` from the schema and document the partial index in the migration file. Service layer enforces "no two pending" at write time.

### Article relation back-pointer

Add to the existing `Article` model:

```prisma
ratingReviews ArticleRatingReview[]
```

## 4. Service layer

`src/server/services/article.service.ts` — add three functions next to the existing nsfwLevel logic:

### 4a. `createArticleRatingReview({ articleId, userId, suggestedLevel, userComment })`
- Load article, assert `article.userId === userId` (owner check) **at the service layer, not router middleware** — per memory `feedback_service_layer_auth.md`.
- Assert no existing `Pending` row for `articleId`. If one exists, throw `BadRequest("A review is already pending for this article")`.
- Assert `suggestedLevel` is a valid bitwise level constant from `~/shared/constants/browsingLevel.constants`.
- Snapshot `article.nsfwLevel` into `currentLevel`.
- Insert row. Return the inserted record.

### 4b. `getArticleRatingReviews({ cursor, limit, status })` (mod)
- Mirrors `getImageRatingRequests` (`src/server/services/image.service.ts:6426`).
- Status defaults to `Pending`, cursor on `id`.
- Joins owner, current article snapshot (`title`, `nsfwLevel`, `userNsfwLevel`, `moderatorNsfwLevel`, cover image url), and pending-review user comment.
- Return shape designed to drive the dashboard card directly (one round-trip per page).

### 4c. `resolveArticleRatingReview({ reviewId, moderatorId, appliedLevel, status, modComment })`
- Load review with `status: Pending`. Throw if missing or already resolved.
- If `status === 'Actioned'`:
  - Update `Article.moderatorNsfwLevel = appliedLevel`, push `'userNsfwLevel'` into `lockedProperties` (matches existing override flow at `article.service.ts:1015-1022`).
  - Call `updateArticleNsfwLevels([articleId])` to re-roll the effective level (the override path already takes precedence inside that function — confirm during impl).
- If `status === 'Unactioned'`: no article mutation; just close the row. (Plan originally said `Dismissed`; actual `ReportStatus` enum uses `Unactioned`.)
- Write `status`, `resolvedAt`, `resolvedBy`, `appliedLevel`, `modComment` on the review row.
- Call `trackModActivity({ userId: moderatorId, entityType: 'article', entityId: articleId, activity: 'ratingReview' })`.
- Enqueue notification (see §6).
- Wrap article + review writes in a single `dbWrite.$transaction`.

### 4d. Edit-time rescan warning (existing flow)
`upsertArticleHandler` at `article.service.ts:1001-1022` already handles the override invariant. Add: when the existing article has `moderatorNsfwLevel != null` and the owner is the one editing (`isModerator === false`), set a flag on the response (`hasModeratorOverride: true`) so the client can show the warning popover. No server-side block — the rescan from edit is allowed; we just need the dialog. The owner edit path already calls `rescanArticle`, which clears `contentScannedAt` and reopens scoring. Keep that behavior; the popover is purely informational.

## 5. tRPC routes

Schema file: `src/server/schema/article.schema.ts`
- `createArticleRatingReviewSchema` → `{ articleId: number, suggestedLevel: number, userComment?: string (max 500) }`
- `getArticleRatingReviewsSchema` → `{ limit?: number (1-100, default 50), cursor?: number, status?: ReportStatus }`
- `resolveArticleRatingReviewSchema` → `{ reviewId: number, status: 'Actioned' | 'Unactioned', appliedLevel?: number, modComment?: string (max 1000) }`. `appliedLevel` required when `status === 'Actioned'`.

Router: `src/server/routers/article.router.ts`

```ts
createRatingReview: protectedProcedure
  .input(createArticleRatingReviewSchema)
  .mutation(({ input, ctx }) =>
    createArticleRatingReview({ ...input, userId: ctx.user.id })),

getRatingReviews: moderatorProcedure
  .input(getArticleRatingReviewsSchema)
  .query(({ input }) => getArticleRatingReviews(input)),

resolveRatingReview: moderatorProcedure
  .input(resolveArticleRatingReviewSchema)
  .mutation(({ input, ctx }) =>
    resolveArticleRatingReview({ ...input, moderatorId: ctx.user.id })),

getMyArticleRatingReview: protectedProcedure
  .input(z.object({ articleId: z.number() }))
  .query(({ input, ctx }) =>
    getArticleRatingReviewForOwner({ articleId: input.articleId, userId: ctx.user.id })),
```

The last one is so the article detail page can render the dispute button state ("Submit review" / "Pending review submitted on X" / "Resolved: …").

## 6. Notifications

New processor at `src/server/notifications/article-rating-review.notifications.ts`. Two notification types, both in `NotificationCategory.System`:

| Key | When | Details |
|-----|------|---------|
| `article-rating-review-approved` | mod actioned + applied a new level | `{ articleId, previousLevel, newLevel, modComment }` |
| `article-rating-review-rejected` | mod dismissed | `{ articleId, modComment }` |

Send via `createNotification()` inside `resolveArticleRatingReview` (parallel to `image.controller.ts:209-220`). Register the processor in the notification index alongside the existing `articleNotifications`.

## 7. UI

### 7a. Article detail page — owner controls
`src/pages/articles/[id]/[[...slug]].tsx`. For the article owner only:
- Show the **aggregate/effective `nsfwLevel`** as a labeled chip near the article header. Mods already see this, owners don't.
- Below it: a "Request rating review" button when no pending review exists. Disabled (with status text) when one is pending.
- Click opens a modal (Mantine, register in `Dialog/dialog-registry.ts`):
  - `Select` of valid `nsfwLevel` choices (PG / PG-13 / R / X / XXX), defaulted to whatever they think is right (not necessarily their stored `userNsfwLevel`).
  - `Textarea` for optional comment (500 char limit).
  - Link to the self-check guideline page (§8).
  - Submit calls `trpc.article.createRatingReview`. Optimistic UI: button flips to "Review pending".

### 7b. Article edit — warning popover
On submit inside the edit flow, if `hasModeratorOverride === true`, show a Mantine confirm modal:

> A moderator previously set this article's rating manually. Editing will trigger a rescan and may reset the rating. Continue?

Buttons: `Cancel` / `Save and rescan`. Confirming proceeds with the existing publish/upsert call.

### 7c. Mod dashboard
New page: `src/pages/moderator/article-rating-review.tsx`. Mirror `image-rating-review.tsx`:
- Title + limit dropdown + status filter (Pending | Actioned | Dismissed).
- Infinite list of `ArticleRatingReviewCard` components.

`ArticleRatingReviewCard` (new in `src/components/Article/ArticleRatingReviewCard.tsx`):
- Cover image (EdgeImage) + link to article detail.
- Title, owner username (linked).
- Three nsfwLevel chips side-by-side: **System**, **Owner suggested**, **Mod applied** (empty until resolved).
- Owner comment (collapsed by default).
- Action row: nsfwLevel `SegmentedControl` (PG → XXX), optional `Textarea` for mod comment, `Approve` (Actioned) + `Dismiss` buttons. "Require reason" toggle on the page header forces non-empty comment on dismiss (mirrors image dashboard).
- On approve: calls `resolveRatingReview` with `status: 'Actioned'` and the selected level. On dismiss: `status: 'Dismissed'`.

### 7d. Moderator link
Add the page to whichever index lists moderator dashboards. Search `src/pages/moderator/` for the existing nav/index pattern when implementing.

## 8. Public self-check guideline

Hosted on **education.civitai.com** (external content site, maintained alongside other public guidelines). Implementation: write the page in that site's repo/CMS and link to it from the app via a single URL constant in `src/server/common/constants.ts`. Contents:

1. **Article rating mechanics in plain English** — cover image, body images, and title/text all contribute; the highest signal wins.
2. **What "wildly different" looks like** — examples from the source ticket table (PG cover + R body images = R article).
3. **Pre-flight checklist** (from the customer's own suggested shape):
   - Title doesn't contain NSFW trigger words (link to the published trigger-word reference).
   - Cover image is rated at the level you want the article to land at.
   - Body images don't include explicit demo content. If they have to, the article belongs on `.red`.
4. **How to dispute** — screenshot of the button + what mods look at.
5. **What gets declined** — disputes that try to escape the `.red` gate by ignoring body content.

Link to this page from:
- The dispute submission modal (§7a).
- The article publish dialog (small "rating guidelines" link near the nsfwLevel selector).

## 9. Metrics / abuse signal (instrumentation only)

Per the ticket's "Track submission rate + accept/reject ratio to detect abuse" requirement. Don't gate, don't auto-reject — just emit so we can build a follow-up if needed:

- Emit a ClickHouse event on submit + on resolve (`articleRatingReview`, `articleRatingReviewResolved`). Schema mirrors existing `trackAction` calls in `src/server/services/track.service.ts`.
- Add a mod-only "stats" strip at the top of the dashboard: pending count, last-30d approval rate, top-10 submitters by volume.

## 10. Rollout

1. Migration: add table + partial unique index. Verify on staging.
2. Service + tRPC + notification processor. Add unit tests for `createArticleRatingReview` (one-pending invariant, owner check, valid level) and `resolveArticleRatingReview` (state transitions, override write, notification fire). Vitest, per CLAUDE.md memory.
3. UI behind a Flipt flag (`articleRatingDispute`, Flipt key `article-rating-dispute`). Owner-only flag check on the button; mod dashboard page check on the route.
4. Self-check guideline page lands at the same time the flag flips on.
5. Open at 100% after one week of staging soak (no expected risk surface — it's a new isolated table).

## 11. Decisions (resolved)

- **One active dispute per article**: confirmed. Owner can submit a new one only if `Article.updatedAt > lastReview.resolvedAt`. Server-side check inside `createArticleRatingReview`.
- **Rate limit**: 3 disputes per 24h per user, mods bypass — mirrors `rescanArticle` precedent at `article.service.ts:2127`.
- **Guideline page**: published on **education.civitai.com**. App links to it via a constant; not in-repo MDX.
- **Notification copy** (final):
  - **Approved** (`article-rating-review-approved`):
    Title: `Your article rating was updated`
    Body: `A moderator reviewed your dispute on "{articleTitle}" and updated the rating from {previousLevel} to {newLevel}.{ modComment ? ' Note from moderator: ' + modComment : '' }`
    CTA: link to article.
  - **Rejected** (`article-rating-review-rejected`):
    Title: `Your article rating dispute was declined`
    Body: `A moderator reviewed your dispute on "{articleTitle}" and the current rating ({currentLevel}) was kept.{ modComment ? ' Reason: ' + modComment : '' } See the rating guidelines at education.civitai.com to understand what drove the rating.`
    CTA: link to article + link to guideline page.
- **Models**: out of scope for this ticket. Not deferred-with-follow-up — drop from plan.

---

## 12. As-built deviations (post-implementation)

- **Enum**: plan said `Dismissed`. Actual Prisma `ReportStatus` enum is `Pending | Processing | Actioned | Unactioned`. All code uses `Unactioned`. User-facing label can still read "Dismissed" / "Declined" — only the wire value matters.
- **Tracker path**: plan referenced `src/server/services/track.service.ts`. Actual ClickHouse Tracker class lives at `src/server/clickhouse/client.ts`. Two new methods added there: `articleRatingReview`, `articleRatingReviewResolved`.
- **Tracker call site**: emitted from the **router layer** (`article.router.ts`), not the service. Matches `ctx.track` pattern used by `bug.router.ts` / `redeemableCode.router.ts`. Calls are `.catch()`-swallowed so a tracking failure can't fail the user-facing mutation.
- **Mod activity type**: widened `ArticleModActivity['activity']` in `src/server/services/moderator.service.ts` to include `'ratingReview'`. No cast at the call site.
- **Edit-flow warning**: implemented as a **pre-submit** check on the client (`article.moderatorNsfwLevel != null && !isModerator`), not a post-response flag. Reason: rescan is destructive and irreversible — the owner needs the choice before the mutation fires, not after. The `hasModeratorOverride` response field is still returned by the service for defense in depth, but the client doesn't depend on it.
- **Dialog registry**: registered in `src/components/Dialog/dialog-registry2.ts` (the active v2 registry). `dialog-registry.ts` was not modified.
- **Notification index**: registered in `src/server/notifications/utils.notifications.ts` (the existing registry file), not a separate index.
- **Flipt flag registered as `articleRatingDispute`** (Flipt key `article-rating-dispute`) in `src/server/services/feature-flags.service.ts`. Router procedures attach via `isFlagProtected('articleRatingDispute')`. Earlier `TODO(article-nsfw-dispute)` comments have been resolved.
- **ClickHouse tables** `articleRatingReviews` + `articleRatingReviewsResolved` need to be created on the CH side before events fire at runtime.
- **Guideline URL slug** is a placeholder (`/articles/article-rating-guidelines`). Finalize in `src/server/common/constants.ts` once the education.civitai.com page is published.
- **Migration timestamp**: `20260522120000_article_rating_review`. Includes the partial unique index that Prisma can't express natively.

## Appendix: file map

| Layer | Path |
|-------|------|
| Schema | `prisma/schema.full.prisma` (add model, regen via `pnpm db:generate`) |
| Migration | `prisma/migrations/<timestamp>_article_rating_review/migration.sql` (partial unique) |
| Service | `src/server/services/article.service.ts` (3 new fns + warning flag in upsert response) |
| Schema (zod) | `src/server/schema/article.schema.ts` |
| Router | `src/server/routers/article.router.ts` (4 procedures) |
| Notifications | `src/server/notifications/article-rating-review.notifications.ts` + register in notifications index |
| Owner UI | `src/pages/articles/[id]/[[...slug]].tsx`, new dispute modal + edit warning |
| Mod dashboard | `src/pages/moderator/article-rating-review.tsx`, `src/components/Article/ArticleRatingReviewCard.tsx` |
| Self-check page | education.civitai.com (external); URL constant in `src/server/common/constants.ts` |
| Feature flag | Flipt `articleRatingDispute` (key `article-rating-dispute`) |
| Metrics | `src/server/clickhouse/client.ts` (`articleRatingReview` + `articleRatingReviewResolved` events) |
