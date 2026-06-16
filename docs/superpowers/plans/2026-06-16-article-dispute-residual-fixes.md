# Article Rating Dispute — Residual Loophole Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining actionable gaps in the article-rating-dispute auto-approve system that the basis-snapshot fix did not cover.

**Architecture:** Both fixes are code-only (no schema change — the `Article.moderatorNsfwLevelBasis` column already exists). Task 1 tightens *when* the basis is re-snapshotted by extracting a pure predicate (TDD-testable). Task 2 removes a concurrency window in the auto-approve submission path by routing the auto-approve through the DB's existing partial-unique-index guard instead of a direct `Actioned` insert.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), tRPC, Vitest (unit tests via `pnpm vitest run <path>` / `pnpm test:unit:run`).

## Global Constraints

- **No db-mocked service tests.** Project convention (see `src/server/services/blocks/__tests__/rate-card.test.ts`) is pure-function unit tests only. DB-coupled logic must be covered by extracting a pure helper and testing that; the DB-transaction behavior itself is verified by reasoning + manual/integration check, not by mocking `dbRead`/`dbWrite`.
- **Migrations are manual** — N/A here, neither task changes the schema.
- **Numeric `NsfwLevel`** (bitwise, `Blocked = 32`) is imported from `~/server/common/enums` — NOT the Prisma string enum of the same name in `~/shared/utils/prisma/enums`.
- Don't run `prettier`/`typecheck`/`lint` unprompted; rely on editor diagnostics + a final `pnpm run typecheck` (the editor's Prisma-client types can lag a `db:generate` — trust the CLI typecheck).
- Verify with `pnpm run typecheck` (expect exit 0) before claiming done.

---

## Severity / priority summary

| # | Gap | Severity | This plan |
|---|-----|----------|-----------|
| Residual | Basis not re-snapshotted when a mod re-affirms an unchanged above-images override → a later dispute can still auto-clear against a stale basis | 🟡 narrow security (re-opens part of loophole #1) | **Task 1** |
| #4 | Concurrent submission auto-approve double-inserts `Actioned` rows (partial unique index only guards `status='Pending'`) | 🟢 data dupe + double notification; article state stays consistent | **Task 2** |
| #3 | Re-edit gate satisfied by any `updatedAt` bump (cosmetic edit re-opens re-dispute) | 🟢 queue-spam, rate-limited 3/day | **Deferred** (see end) |
| Stale Pending | No-override dispute leaves a lingering Pending row after a content edit drops the live rating | 🟢 queue noise | **Deferred** (you deprioritized) |

---

## Task 1: Re-snapshot override basis on every moderator override assertion

**Why:** Today `Article.moderatorNsfwLevelBasis` is written only inside the `moderatorOverrideChanged` branch of `upsertArticle` (i.e. only when the override *value* changes). A moderator who re-saves an article while *keeping* an above-images override does not refresh the basis, so a later down-direction dispute is judged against the stale original snapshot and can still auto-clear (`evaluateAutoApproveGate` gate #6 `derived < basis` passes). Re-stamping on any moderator save that carries a non-null override fixes it. Re-stamping is always safe: the basis is set to `derived` at stamp time, so it can only make a future auto-approve *more* conservative — it can never open a new hole.

**Files:**
- Create: `src/server/services/__tests__/article-rating-review.helpers.test.ts`
- Modify: `src/server/services/article-rating-review.helpers.ts` (add `shouldRestampOverrideBasis`)
- Modify: `src/server/services/article.service.ts:~1037-1047` (upsert basis branch) + import the new helper

**Interfaces:**
- Produces: `shouldRestampOverrideBasis(args: { isModerator: boolean; payloadOverride: number | null | undefined; currentOverride: number | null }): boolean`
  - Consumed by `upsertArticle` to decide whether to compute+write a fresh basis.

- [ ] **Step 1: Write the failing test**

Create `src/server/services/__tests__/article-rating-review.helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldRestampOverrideBasis } from '~/server/services/article-rating-review.helpers';

describe('shouldRestampOverrideBasis', () => {
  it('restamps when a moderator asserts a non-null override (value changed)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: 4, currentOverride: 8 })
    ).toBe(true);
  });

  it('restamps when a moderator re-affirms the SAME non-null override (the residual case)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: 4, currentOverride: 4 })
    ).toBe(true);
  });

  it('does NOT restamp when the override is being cleared (null) — caller writes null basis', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: null, currentOverride: 4 })
    ).toBe(false);
  });

  it('does NOT restamp when the payload omits the override field (undefined)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: undefined, currentOverride: 4 })
    ).toBe(false);
  });

  it('does NOT restamp for a non-moderator save', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: false, payloadOverride: 4, currentOverride: null })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/article-rating-review.helpers.test.ts`
Expected: FAIL — `shouldRestampOverrideBasis is not a function` / import error.

- [ ] **Step 3: Add the helper**

In `src/server/services/article-rating-review.helpers.ts`, add (near the top, after the imports / above `computeArticleDerivedNsfwLevel`):

```ts
/**
 * Whether `upsertArticle` should re-snapshot `moderatorNsfwLevelBasis` on this
 * save. We re-stamp whenever a moderator save asserts a NON-NULL override —
 * even if the value is unchanged — so the basis reflects the mod's most recent
 * intent rather than the first time the override was ever set (the residual
 * gap that let a re-affirmed above-images override still be auto-cleared).
 *
 * Clearing the override (payloadOverride === null) returns false here; the
 * caller writes a null basis for that case explicitly. An omitted field
 * (undefined) leaves the existing basis untouched.
 *
 * Re-stamping is always safe: the basis is written as `derived` at stamp time,
 * so it can only ever make a future auto-approve MORE conservative
 * (`evaluateAutoApproveGate` gate #6 requires `derived < basis`).
 */
export function shouldRestampOverrideBasis(args: {
  isModerator: boolean;
  payloadOverride: number | null | undefined;
  currentOverride: number | null;
}): boolean {
  return args.isModerator && args.payloadOverride != null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/article-rating-review.helpers.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Wire the helper into `upsertArticle`**

In `src/server/services/article.service.ts`, the current basis branch is:

```ts
    let moderatorNsfwLevelBasis: number | null | undefined = undefined;
    if (moderatorOverrideChanged) {
      const lockedSet = new Set<string>(data.lockedProperties ?? article.lockedProperties ?? []);
      if (data.moderatorNsfwLevel != null) {
        lockedSet.add('userNsfwLevel');
        moderatorNsfwLevelBasis = (await computeArticleDerivedNsfwLevel(id as number)) ?? 0;
      } else {
        lockedSet.delete('userNsfwLevel');
        moderatorNsfwLevelBasis = null;
      }
      data.lockedProperties = Array.from(lockedSet);
    }
```

Replace it with (lock/unlock stays tied to a value *change*; basis re-stamps on any mod assertion of a non-null override, and clears on an explicit null):

```ts
    // Lock/unlock the user picker only when the override VALUE changes.
    let moderatorNsfwLevelBasis: number | null | undefined = undefined;
    if (moderatorOverrideChanged) {
      const lockedSet = new Set<string>(data.lockedProperties ?? article.lockedProperties ?? []);
      if (data.moderatorNsfwLevel != null) lockedSet.add('userNsfwLevel');
      else lockedSet.delete('userNsfwLevel');
      data.lockedProperties = Array.from(lockedSet);
    }
    // Re-snapshot the basis on every moderator assertion of a non-null override
    // (even an unchanged re-affirm), and clear it when the override is cleared.
    // See shouldRestampOverrideBasis for why aggressive re-stamping is safe.
    if (!!isModerator && data.moderatorNsfwLevel === null) {
      moderatorNsfwLevelBasis = null;
    } else if (
      shouldRestampOverrideBasis({
        isModerator: !!isModerator,
        payloadOverride: data.moderatorNsfwLevel,
        currentOverride: article.moderatorNsfwLevel,
      })
    ) {
      moderatorNsfwLevelBasis = (await computeArticleDerivedNsfwLevel(id as number)) ?? 0;
    }
```

Add `shouldRestampOverrideBasis` to the existing import from `~/server/services/article-rating-review.helpers` (the block around line 87 that already imports `computeArticleDerivedNsfwLevel`).

(The `...(moderatorNsfwLevelBasis !== undefined ? { moderatorNsfwLevelBasis } : {})` spread in the `tx.article.update` data is unchanged and already consumes this variable.)

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: exit 0, 0 errors.

- [ ] **Step 7: Manual verification note (no automated coverage for the DB path)**

Confirm by reasoning against `evaluateAutoApproveGate`: after a mod re-saves keeping override R on an article whose images are now PG, basis is re-stamped to `derived` (PG=1). A later dispute to PG yields `derived(1) < basis(1)` → false → routed to mod queue (no auto-clear). Document this in the PR description.

- [ ] **Step 8: Commit**

```bash
git add src/server/services/article-rating-review.helpers.ts src/server/services/article.service.ts src/server/services/__tests__/article-rating-review.helpers.test.ts
git commit -m "fix(article-dispute): re-snapshot override basis on every mod override assertion"
```

---

## Task 2: Close the concurrent auto-approve double-insert window

**Why:** In `createArticleRatingReview`, the "one Pending per article" check is a `dbRead` (advisory), and the auto-approve path inserts the review directly as `status: Actioned` (`autoResolveArticleRatingReview` mode `'create'`). The partial unique index `ArticleRatingReview_pending_per_article` only guards `WHERE status='Pending'`, so two concurrent submissions can both pass the read check and both insert `Actioned` rows → duplicate reviews + duplicate "approved" notifications (article state stays consistent because both writes are idempotent). Fix: in the eligible branch, insert the review as **Pending first** (the partial unique index serializes concurrent submissions — the loser gets `P2002`), then promote it via the already-race-safe `mode: 'resolve-existing'` path.

**Files:**
- Modify: `src/server/services/article.service.ts` — the `if (gate.eligible) { ... }` block inside `createArticleRatingReview`

**Interfaces:**
- Consumes: `autoResolveArticleRatingReview({ mode: 'resolve-existing', reviewId, articleId, ownerUserId, suggestedLevel, previousLevel, articleTitle })` and `AutoResolveRaceLost` (both already exported from `~/server/services/article-rating-review.helpers`, already imported here).
- Consumes: `Prisma` (already imported in this file for the raw-SQL queries) for the `P2002` check.

- [ ] **Step 1: Replace the eligible branch**

Current:

```ts
    if (gate.eligible) {
      const auto = await autoResolveArticleRatingReview({
        mode: 'create',
        articleId,
        ownerUserId: userId,
        suggestedLevel,
        userComment: userComment ?? null,
        previousLevel: article.nsfwLevel,
        articleTitle: article.title ?? 'your article',
      });

      logToAxiom({
        type: 'info',
        name: 'article-rating-review-auto-resolved',
        articleId,
        reviewId: auto.reviewId,
        suggestedLevel,
        derivedLevel: gate.derivedLevel,
        entryPoint: 'submission',
      }).catch();

      return auto.review;
    }
```

Replace with:

```ts
    if (gate.eligible) {
      // Insert as Pending FIRST so the partial unique index
      // (`ArticleRatingReview_pending_per_article`, WHERE status='Pending')
      // serializes concurrent submissions for the same article — the loser of
      // the race hits P2002 and is rejected here rather than producing a
      // duplicate Actioned row + duplicate "approved" notification. We then
      // promote the row via the race-safe resolve-existing path.
      let pendingId: number;
      try {
        const created = await dbWrite.articleRatingReview.create({
          data: {
            articleId,
            userId,
            currentLevel: article.nsfwLevel,
            suggestedLevel,
            userComment,
            status: ReportStatus.Pending,
          },
          select: { id: true },
        });
        pendingId = created.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw throwBadRequestError('A review is already pending for this article');
        }
        throw e;
      }

      try {
        const auto = await autoResolveArticleRatingReview({
          mode: 'resolve-existing',
          reviewId: pendingId,
          articleId,
          ownerUserId: userId,
          suggestedLevel,
          previousLevel: article.nsfwLevel,
          articleTitle: article.title ?? 'your article',
        });

        logToAxiom({
          type: 'info',
          name: 'article-rating-review-auto-resolved',
          articleId,
          reviewId: auto.reviewId,
          suggestedLevel,
          derivedLevel: gate.derivedLevel,
          entryPoint: 'submission',
        }).catch();

        return auto.review;
      } catch (e) {
        // Another resolver (a mod, or the scan-completion retry) won the race
        // and promoted this row first. Return the row as-is; it is already
        // resolved and the article mutation stands.
        if (e instanceof AutoResolveRaceLost) {
          return dbRead.articleRatingReview.findUniqueOrThrow({ where: { id: pendingId } });
        }
        throw e;
      }
    }
```

Notes for the implementer:
- `userComment` is persisted on the Pending insert, so it survives the promotion — `mode: 'resolve-existing'` does not need to carry it.
- `mode: 'create'` in `autoResolveArticleRatingReview` becomes unused after this change. Leave it in place for now (out of scope to delete); a follow-up may remove it.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: exit 0, 0 errors. (Confirms `Prisma`, `AutoResolveRaceLost`, `throwBadRequestError`, `dbWrite`, `dbRead` are all in scope — they already are in this file.)

- [ ] **Step 3: Manual / integration verification (no unit coverage for the race)**

The race cannot be covered by the project's pure-function unit tests. Verify the non-race behavior end-to-end via the existing flow (submit an auto-approve-eligible dispute → one Actioned row, one notification, article level lands at `suggestedLevel`). For the race itself, reason from the partial unique index: two concurrent `create` inserts of `status='Pending'` for the same `articleId` → exactly one succeeds, the other throws `P2002` → caller returns a 400. Document this in the PR. Optionally add a throwaway integration check via a `src/pages/api/testing/*` endpoint (see Task 3 option below) that fires two concurrent submissions.

- [ ] **Step 4: Commit**

```bash
git add src/server/services/article.service.ts
git commit -m "fix(article-dispute): serialize concurrent auto-approve via Pending-insert guard"
```

---

## Deferred (documented, not scheduled here)

### #3 — Re-edit gate accepts cosmetic `updatedAt` bumps
**Severity:** 🟢 (queue-spam pressure, already bounded by the 3/day rate limit).
**What it needs (design decision required before coding):** the gate at `article.service.ts:2394-2395` allows a fresh dispute whenever `article.updatedAt > lastResolved.resolvedAt`. To require a *meaningful* change, gate instead on "the article was re-scanned since the last resolution" — e.g. compare `lastResolved.resolvedAt` against a scan timestamp (`contentScannedAt` / a successful ingestion settle) rather than `updatedAt`. This needs a product call on what counts as "re-editable" and a check that the chosen timestamp is reliably bumped on real edits. Not worth doing until the spam is observed.

### Stale Pending row when there is no override
**Severity:** 🟢 (queue noise; the live recompute already lowers the displayed rating). Deprioritized by the user. If addressed later: in `maybeAutoResolveDisputeAfterScan` (or a recompute hook), auto-close a Pending review whose article has no override and whose live `nsfwLevel <= suggestedLevel` after a rescan, with a system mod-comment — but only if product wants disputes auto-closed rather than mod-reviewed.

### Optional: testing endpoint
A `src/pages/api/testing/article-dispute.ts` (guarded by `WebhookEndpoint`) exposing actions to (a) set an override + basis on an article, (b) fire N concurrent submissions, (c) trigger a rescan — would make Tasks 1 & 2 manually verifiable without hand-editing the DB. Follows the pattern in `src/pages/api/testing/referrals.ts`.

---

## Self-Review

- **Spec coverage:** Residual basis gap → Task 1. #4 concurrency → Task 2. #3 + stale-Pending → explicitly deferred with rationale. ✓
- **Placeholder scan:** No TBD/TODO; all code steps carry full code. ✓
- **Type consistency:** `shouldRestampOverrideBasis` signature is identical in its definition (Task 1 Step 3), its test (Step 1), and its call site (Step 5). `autoResolveArticleRatingReview` resolve-existing args match the existing call in `maybeAutoResolveDisputeAfterScan`. ✓
- **No schema change:** both tasks are code-only; `moderatorNsfwLevelBasis` already exists. ✓
