# Article Ingestion Status — Design Proposal

**Status**: Draft, pending implementation decision
**Context**: Surfaced during review of [`article-scanning-rollout.md`](./article-scanning-rollout.md) on 2026-04-10, updated 2026-04-12
**Related**: civitai/civitai#1879 (`feature/scan-article-images`), [`article-content-scanning.md`](./article-content-scanning.md)

---

## TL;DR

Add an `ArticleIngestionStatus` enum + `Article.ingestion` column that mirrors how `Image.ingestion` already gates image serving. Non-owner, non-moderator article reads filter on `ingestion = 'Scanned'`. This:

1. ~~Closes the legacy-backfill Green exposure window~~ — **mitigated by deployment strategy** (see §"Gap 1" below). Backfills run against prod DB from staging before the production deploy, so legacy articles are already scanned when Green access turns on.
2. Supersedes the accepted async text-scan window decision from 2026-04-10 — not by reversing it, but by offering a gating mechanism the earlier discussion didn't consider.
3. Unifies image and text scan gating under a single predicate.
4. Separates scan state (system) from publication state (user intent), which removes most of the awkwardness around `ArticleStatus.Processing`.
5. Adds proper scan-lifecycle date tracking (`scanRequestedAt`, `scannedAt`) to Article, mirroring Image. Fixes the `contentScannedAt` misnomer and closes the gap where text-only articles have no scan timestamp at all.

**Decision pending**: ship this as a followup (recommended) vs. absorb into the current PR (bigger scope, cleaner landing).

---

## The problem this solves

### Gap 1 — Legacy backfill exposes unscanned content to Civitai Green (MITIGATED)

> **2026-04-12 update**: This gap is closed by the deployment strategy. Both backfills will run against the prod DB from a staging environment *before* the production deploy ships `articles: ['public']`. By the time Green access turns on, every legacy article already has correct `ImageConnection` rows, recomputed `nsfwLevel` masks, and `EntityModeration` results. There is no window where unscanned legacy content is visible to Green.
>
> The original analysis below is preserved for context on why the gap existed in the first rollout sequence, but it is no longer a blocker.

<details>
<summary>Original analysis (preserved for context)</summary>

The current rollout sequence (§4 of `article-scanning-rollout.md`) is:

1. Deploy code — feature flags already at `articles: ['public']` → Civitai Green starts serving the entire legacy article corpus immediately.
2. Run image backfill (`migrate-article-images.ts`).
3. Run text moderation backfill (`migrate-article-text-moderation.ts`).

Between steps 1 and 2, a legacy article's `nsfwLevel` is computed from **just** cover image + `userNsfwLevel` — because `ImageConnection` rows for content images don't exist yet, so `GREATEST(max(cover), max(content))` in `updateArticleNsfwLevels` has nothing to max over on the content side. Text moderation hasn't run, so no `floor: NsfwLevel.R` has been applied either. (Pre-2026-04-17: same effective outcome, just expressed as "`article.nsfw` is still `false`".)

So a legacy article with a PG cover, NSFW content images embedded in the body, and NSFW text currently has `nsfwLevel = PG`. After step 1 deploys, Civitai Green filters by `(nsfwLevel & publicBrowsingLevelsFlag) != 0` and happily serves that article. The backfills eventually fix it, but the entire legacy corpus is visible to Green at its **pre-scan** level for the duration of the backfill window.

The commit message for `28b38c7dd` acknowledges that legacy masks are wrong and will be updated by the backfill. `article-scanning-rollout.md` §2.3 calls this out directly: "running `updateArticleNsfwLevels` over legacy articles (which happens implicitly when backfills complete) will change existing masks for any article that mixed PG + NSFW content images under the old code." Any article whose mask *changes* during the backfill was being served at the wrong level *before* the backfill ran. That's the leak window.

</details>

### Gap 2 — The live text-scan window is still there

Per the 2026-04-10 project decision, new text-only articles publish before their xGuard scan completes. That decision was made because the alternative (Option A: force Processing on all new articles) added visible UX cost — authors would see a "Processing" dialog on what used to be instant-publish.

This proposal is **not** Option A. It closes the window without the UX cost, because the gate is serving-side, not publication-side. Authors still publish instantly from their POV. Green just doesn't see the article until both scans complete.

---

## The proposal

### Schema

```prisma
enum ArticleIngestionStatus {
  Pending   // at least one scan (image or text) hasn't completed
  Scanned   // both image extraction+scan and text moderation completed successfully
  Blocked   // text moderation blocked OR an image scan blocked
  Error     // text moderation failed/expired OR image scan errored terminally
  Rescan    // content changed, needs re-scanning (mirrors ImageIngestionStatus.Rescan)
}

model Article {
  // ... existing fields
  contentScannedAt DateTime?              // repurposed: set when BOTH scans complete (was: set at image-link time)
  ingestion        ArticleIngestionStatus @default(Pending)
  scanRequestedAt  DateTime?              // when scan was first requested (image link + text submit)

  @@index([status, ingestion, nsfwLevel])  // supports the Green query shape
}
```

These fields mirror `Image.scanRequestedAt` and `Image.scannedAt`. They give us:

- **Filterability**: query for articles that were never scanned (`contentScannedAt IS NULL`), or that have been waiting too long (`scanRequestedAt < NOW() - INTERVAL '1 hour'` AND `ingestion = 'Pending'`).
- **Observability**: measure scan latency (`contentScannedAt - scanRequestedAt`), find stuck articles, build dashboards.
- **Parity with Image**: same semantics, same query patterns.

#### `contentScannedAt` repurposed (not deprecated)

The existing `contentScannedAt` field was previously set when `linkArticleContentImages` ran (i.e., when image *links* were created), not when scanning *completed*. Text-only articles never got it set at all.

**New semantics**: `contentScannedAt` is now set **only** inside `recomputeArticleIngestion` when `ingestion` transitions to `Scanned` — meaning both image scans and text moderation have completed successfully. The name is now accurate: "when was this article's content actually scanned."

`scanRequestedAt` replaces the old `contentScannedAt` write timing — it's set when `linkArticleContentImages` + `submitTextModeration` fire, tracking "when did we kick off scanning."

**Migration**: adds two new fields (`ingestion`, `scanRequestedAt`). `ingestion` defaults to `Pending`. `contentScannedAt` keeps its column but its write sites are redirected. Every existing article is `Pending` on schema apply — **every legacy article is immediately invisible to Civitai Green the moment the migration runs** (if the serving gates are deployed with the migration). `scanRequestedAt` defaults to `NULL` for legacy articles and gets populated as backfills run.

### Serving-path gate

Every public/Green read path already filters on `status = 'Published'` and `nsfwLevel & browsingLevelsFlag != 0`. Add one more predicate for non-owner, non-moderator callers:

```sql
AND a.ingestion = 'Scanned'
```

Call sites identified in the initial gotchas review:

- `getArticles` (`src/server/services/article.service.ts:257`)
- `getArticleById` (`src/server/services/article.service.ts:639`)
- `getCivitaiNews`, `getCivitaiEvents`
- `sitemap-articles.xml`
- `/api/og`
- `articles.search-index.ts:175` — Meilisearch pull filter (scoped to `status = Published` today; add `ingestion = 'Scanned'`)
- Any feed/query that goes through `getArticles`-style gates

Mods and owners see any ingestion state so authors don't lose visibility of their own in-flight articles.

### State transitions — Option A (derive from ground truth on events, recommended)

No new bookkeeping fields. Implement a helper that recomputes `Article.ingestion` from the tables that are already the source of truth:

```ts
// src/server/services/article.service.ts
export async function recomputeArticleIngestion(articleId: number): Promise<void> {
  const [imageAggregate, textModeration] = await Promise.all([
    dbWrite.$queryRaw<{
      pending: bigint;
      blocked: bigint;
      error: bigint;
      scanned: bigint;
      total: bigint;
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE i.ingestion = 'Pending') as pending,
        COUNT(*) FILTER (WHERE i.ingestion = 'Blocked') as blocked,
        COUNT(*) FILTER (WHERE i.ingestion = 'Error') as error,
        COUNT(*) FILTER (WHERE i.ingestion = 'Scanned') as scanned,
        COUNT(*) as total
      FROM "ImageConnection" ic
      JOIN "Image" i ON i.id = ic."imageId"
      WHERE ic."entityType" = 'Article' AND ic."entityId" = ${articleId}
    `,
    dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: 'Article', entityId: articleId } },
      select: { status: true, blocked: true },
    }),
  ]);

  const agg = imageAggregate[0];
  const noImages = agg.total === 0n;
  const imageDone = noImages || agg.pending === 0n;
  const textDone = textModeration?.status === 'Succeeded';
  const anyBlocked = agg.blocked > 0n || textModeration?.blocked === true;
  const anyError =
    agg.error > 0n ||
    (textModeration && ['Failed', 'Expired', 'Canceled'].includes(textModeration.status));

  const next: ArticleIngestionStatus = anyBlocked
    ? 'Blocked'
    : anyError
    ? 'Error'
    : imageDone && textDone
    ? 'Scanned'
    : 'Pending';

  const now = new Date();
  await dbWrite.article.update({
    where: { id: articleId },
    data: {
      ingestion: next,
      // Set scannedAt only on the transition to Scanned, and only if not already set
      // (mirrors Image.scannedAt logic — preserves original scan date on rescans)
      ...(next === 'Scanned' ? { scannedAt: now } : {}),
    },
  });
}
```

**Important edge case**: a brand-new article with no content images and text moderation pending is `imageDone=true` (no images to wait on) but `textDone=false`, so it correctly stays `Pending`. Don't let the `noImages` shortcut mark it Scanned.

**Call sites for `recomputeArticleIngestion`** (sets `ingestion` + `scannedAt`):

- `src/pages/api/webhooks/image-scan-result.ts` — after each image scan result is processed (it already queries which articles the image belongs to for the debounce logic)
- `src/pages/api/webhooks/text-moderation-result.ts` — inside the `Article` entity handler, after `recordEntityModerationSuccess`/`Failure`
- `src/server/services/article.service.ts` upsert path — after `linkArticleContentImages` + `submitTextModeration` (handles the "new article with no images, text pending" base case — writes `ingestion: Pending` explicitly)
- `src/pages/api/admin/temp/migrate-article-images.ts` — at the end of each processed article
- `src/pages/api/admin/temp/migrate-article-text-moderation.ts` — **not** strictly needed because the text backfill just submits to xGuard; the webhook handler is what updates state when xGuard responds

**Call sites for `scanRequestedAt`** (set once when scanning is first kicked off):

- `src/server/services/article.service.ts` upsert path — set `scanRequestedAt = new Date()` alongside the `linkArticleContentImages` + `submitTextModeration` calls. This is the "we started scanning" timestamp. Covers both image-bearing and text-only articles because text moderation always fires.
- `src/pages/api/admin/temp/migrate-article-images.ts` — set `scanRequestedAt` for each legacy article as it's processed by the backfill (if not already set).
- `src/pages/api/admin/temp/migrate-article-text-moderation.ts` — set `scanRequestedAt` for text-only legacy articles that have no content images and were missed by the image backfill.

### Option B — Two booleans (rejected)

Add `imageScanComplete: Boolean` and `textScanComplete: Boolean` to Article. Each webhook sets its own boolean; a helper derives `ingestion`.

**Rejected because**: two more columns, two more denormalized states that can drift from the ground truth in `Image.ingestion` and `EntityModeration.status`. Option A has the same number of SQL round-trips but no drift risk.

---

## Relationship to `ArticleStatus`

Currently `ArticleStatus.Processing` conflates scan state with publication state. With `Article.ingestion`, we keep both but let them mean different things:

| Axis | Column | Values |
|---|---|---|
| User publication intent | `ArticleStatus` | Draft, Published, Unpublished, UnpublishedViolation |
| System scan state | `ArticleIngestionStatus` | Pending, Scanned, Blocked, Error, Rescan |

**`ArticleStatus.Processing` becomes mostly redundant.** The auto-publish flow in `updateArticleImageScanStatus` (`article.service.ts:1678-1733`) currently does "when all images scanned, flip `status: Processing → Published`". Under the new model, it does "when all images scanned, call `recomputeArticleIngestion(articleId)`, don't touch `status`". If the user's publication intent is Published, they're already Published from their POV — now they become visible to the public when `ingestion` transitions to Scanned.

**Two paths for removing Processing**:

1. **Keep Processing as a no-op transitional state** — don't remove it from the enum, just stop using it. Lowest-risk, minimizes schema churn. Downsides: dead state value, new enum value (`Processing`) from this branch becomes vestigial.
2. **Remove Processing from the enum** — cleaner but requires a second migration, and any external consumer (ClickHouse/Metabase/etc. — see rollout doc §5.7.2) that saw `Processing` during the branch's lifetime has to handle both the new and removed states.

Recommend **Path 1** for this followup. The vestigial enum value can be removed in a later cleanup PR.

**Re-scan on edit** (currently flips `status = Processing` in `article.service.ts:953`): under the new model, flip `ingestion = Rescan` (or back to Pending) instead. Keep `status = Published`. Green can't see the article during the re-scan window, but the author still sees it as Published in their dashboard.

---

## Legacy backfill story

> **2026-04-12 update**: Since Gap 1 is mitigated by running backfills from staging against prod DB before deploy, the ingestion column is no longer the *primary* safety gate for legacy content. However, the `ingestion` column + date fields still provide long-term value: filterability, observability, and a self-gating mechanism for any future backfill or re-scan scenario.

The migration adds `ingestion` (default `Pending`), `scanRequestedAt` (default `NULL`), and `scannedAt` (default `NULL`) to every existing article.

**Backfill flow** (run from staging against prod DB before production deploy):

1. **Image backfill runs** — for each article: extract media, create `ImageConnection` rows, kick off image scans, set `scanRequestedAt = NOW()`. At the end of each article, call `recomputeArticleIngestion(id)`. Articles with no content media transition toward `Scanned` if text side is also done; articles with content media stay `Pending` until the async image scans complete.
2. **Image scan webhooks** — as each content image completes scanning, the webhook calls `recomputeArticleIngestion(articleId)`. When the last scan finishes (and text is already Succeeded), `ingestion` flips to `Scanned` and `scannedAt` is set.
3. **Text backfill runs in parallel** — submits each article to xGuard, sets `scanRequestedAt` if not already set (covers text-only articles). The webhook handler calls `recomputeArticleIngestion` after processing the xGuard response.
4. **Articles light up for Green one at a time**, as each finishes *both* sides. No cliff-edge "all of prod becomes visible at once" moment.
5. **Production deploy** ships with `articles: ['public']`. Legacy corpus is already scanned and has correct `ingestion`, `scannedAt`, and `nsfwLevel` values.

---

## Live path for new articles

1. User creates article → `ingestion = Pending` (default).
2. Upsert path runs `linkArticleContentImages` + `submitTextModeration` → explicitly calls `recomputeArticleIngestion` to lock in `Pending` (or `Scanned` if there's no content and somehow text is already done, which shouldn't happen synchronously).
3. Content images scan asynchronously via the existing image pipeline. Each scan result webhook calls the helper.
4. Text moderation returns asynchronously via xGuard. The text-moderation webhook handler calls the helper.
5. When both are done, `ingestion = Scanned`, article is visible to Green.

Authors don't see a Processing dialog. They don't experience any UX regression from the status quo on `main`. The 2026-04-10 concern about "visible UX cost on instant-publish articles" doesn't apply because the gate is invisible to authors.

---

## Scope estimate

| Area | Files | Rough lines |
|---|---|---|
| Schema migration | `prisma/schema.full.prisma`, generated migration SQL | ~25 |
| Helper function | `src/server/services/article.service.ts` | ~55 |
| Webhook wiring | `image-scan-result.ts`, `text-moderation-result.ts` | ~20 |
| Serving gates | ~6 read sites + Meilisearch index filter | ~50 |
| Remove Processing from auto-publish | `article.service.ts` `updateArticleImageScanStatus` | ~15 |
| Upsert path wiring + `scanRequestedAt` | `article.service.ts` create + update branches | ~20 |
| Re-scan path | `article.service.ts` upsert status-flip logic | ~10 |
| Backfill wiring + `scanRequestedAt` | `migrate-article-images.ts` | ~20 |
| Repurpose `contentScannedAt` writes | `article.service.ts` (old writes → `scanRequestedAt`, new writes via helper) | ~5 |
| Tests | new tests for `recomputeArticleIngestion` transitions + date fields | ~170 |

A few hundred lines across ~15 files + one DB migration. Doable in a session or two of focused work. The existing parity test from the current PR (`src/utils/__tests__/article-extraction-parity.test.ts`) is unaffected.

---

## Open questions to resolve before writing code

1. **Author-facing UI impact** — the `ArticleScanStatus` component in `ArticleUpsertForm.tsx` currently reads `article.status === Processing` to show scan progress. Does it need to switch to reading `article.ingestion === Pending`? If so, what does the author see while text is still scanning but images are done? (Current behavior on text-only articles: nothing — they publish instantly. New behavior: they see a "text scan pending" indicator?) This is the one place where the 2026-04-10 UX concern could resurface. The solution is probably to keep the author-facing indicator quiet for text-only articles and only surface it when the delay exceeds some threshold, or when scan fails.

2. **`article.nsfw` text-moderation flag** — **deprecated 2026-04-17.** Text moderation no longer writes the `nsfw` boolean. Instead, the webhook just calls `updateArticleNsfwLevels([id])`; the service reads the `EntityModeration` row (persisted moments earlier by `recordEntityModerationSuccess`) via an `EXISTS` subquery and applies an R floor when the text was flagged. The field stays in the DB schema for backward compatibility but is no longer read or written anywhere. `ingestion = Blocked` still tracks the orthogonal "text violated ToS" axis via `status = UnpublishedViolation`.

3. **Rescan visibility** — when an author edits a Published article and adds new content, should the article stay visible at the old nsfwLevel until the new scan completes, or should it immediately disappear from Green? The safe answer is "disappear" (flip `ingestion = Rescan`, serving gate hides it). The status-quo-preserving answer is "stay visible at old level" (don't flip ingestion until the new scan completes, at which point update in place). Safe is better for a rollout; revisit later if authors complain.

4. **Processing auto-publish notification** — the "Your article has been published successfully!" message fires on Processing → Published transition. Under the new model: does it fire on `ingestion = Scanned`? Or drop it entirely because the author never saw a "processing" state to begin with? Probably drop it — we're making the scan gate invisible, so a "finished scanning" notification is noise. Except for text-only articles that went through the scan window: those users never expected to see a notification, so dropping is consistent.

5. **Moderation tooling** — any admin UI that filters articles by status. Does it need an ingestion filter too? Probably not — mods should see everything by default, but a "show me articles stuck in Pending" filter might be useful for debugging scan pipeline issues. Add in a followup if requested.

6. **Index choice** — `@@index([status, ingestion, nsfwLevel])` is one option. The actual best index depends on query patterns. Check `getArticles` query plans before committing to a specific shape; a partial index on `(ingestion, nsfwLevel) WHERE status = 'Published'` might be better if most Green queries also filter to Published.

7. **`contentScannedAt` on rescan** — when an author edits a Published article and triggers a rescan, `recomputeArticleIngestion` will overwrite `contentScannedAt` when the new scan completes. The old timestamp is lost. If we need history, consider keeping the old value and only overwriting on Scanned transition (current implementation). This means `contentScannedAt` always reflects "last time all scans were green."

---

## Two paths forward

> **2026-04-12 decision**: Path B was chosen — the ingestion refactor is absorbed into the scanning PR on `feature/scan-article-images`. One clean landing with `ingestion` + `scanRequestedAt` + repurposed `contentScannedAt` available from the start.

### Implementation (Path B — absorbed into this PR)

1. Schema migration adds `ArticleIngestionStatus` enum, `ingestion` (default `Pending`), `scanRequestedAt` columns, and composite index.
2. `recomputeArticleIngestion` helper derives ingestion state from `ImageConnection` + `Image.ingestion` and `EntityModeration` ground truth.
3. Helper is called from: image scan webhook (`updateArticleImageScanStatus`), text moderation webhook (success + failure), and backfill (`migrate-article-images.ts`).
4. Upsert paths set `scanRequestedAt` + `ingestion: Pending` instead of the old premature `contentScannedAt` write.
5. Serving gates (`ingestion = 'Scanned'`) added to: `getArticles`, `getArticleById`, `getCivitaiNews`, Meilisearch index, OG endpoint. Owners and mods bypass.
6. Run backfills from staging against prod DB. Articles light up to `Scanned` as both scan sides complete.
7. Deploy. New articles are gated by `ingestion = 'Scanned'` from day one.

---

## Next-session checklist

Implementation status (2026-04-12):

- [x] **Path B chosen and implemented** — ingestion refactor absorbed into the scanning PR.
- [x] Schema: `ArticleIngestionStatus` enum, `ingestion` + `scanRequestedAt` fields, composite index, migration SQL.
- [x] `recomputeArticleIngestion` helper — derives state from `ImageConnection` + `EntityModeration` ground truth.
- [x] Webhook wiring — image scan (`updateArticleImageScanStatus`) + text moderation (success + failure paths).
- [x] Upsert paths — `scanRequestedAt` + `ingestion: Pending` replaces old `contentScannedAt` writes.
- [x] Serving gates — `getArticles`, `getArticleById`, `getCivitaiNews`, Meilisearch index, OG endpoint.
- [x] Backfill wiring — `migrate-article-images.ts` uses `scanRequestedAt` + calls `recomputeArticleIngestion`.

Still open:

- [ ] Confirm the historical Green state — did `articles: ['public']` on `main` already mean Green sees articles? Check git blame on `src/server/services/feature-flags.service.ts`.
- [ ] The §5.6 parity test (`src/utils/__tests__/article-extraction-parity.test.ts`) and §5.2 stale `Succeeded` re-enforcement fix are still on the table from the original gotchas review.
- [ ] `ArticleScanStatus` UI component — may need updating to read `ingestion` instead of (or in addition to) `status === Processing`.
- [ ] Processing auto-publish notification — currently fires on Processing → Published; consider whether it should also fire on ingestion → Scanned transition, or be dropped.
- [ ] Run `pnpm run typecheck` to verify all type references resolve.

---

## User-triggered rescan

With `Article.ingestion` in place, we can give authors a "request rescan" action for their own articles. This is useful when:

- An article is stuck in `Pending` or `Error` due to a transient scan pipeline issue.
- The author edited their article but scanning didn't re-trigger (e.g., content hash dedupe blocked re-moderation after an xGuard recalibration).
- A moderator restored an article from `UnpublishedViolation` and the author wants to confirm it scans clean.

**Proposed UX**: a button in the article edit form (visible when `ingestion` is not `Scanned`) that:

1. Resets `ingestion = Rescan`, clears `scannedAt` (keeps `scanRequestedAt` for history), and sets a new `scanRequestedAt`.
2. Re-runs `linkArticleContentImages` to pick up any image changes.
3. Re-submits text moderation to xGuard (requires clearing the `contentHash` on `EntityModeration` for this article so the dedupe check doesn't skip it).
4. The normal webhook flow calls `recomputeArticleIngestion` as results come back.

**Rate limiting**: cap at N rescans per article per 24h to prevent abuse. Store count in `ArticleMetadata` or a simple Redis key.

**Scope**: this is a followup feature, not part of the initial ingestion refactor. But the ingestion column and date fields make it trivial to implement later — without them, there's no clean way to track "rescan requested" vs "never scanned" vs "scan complete".

---

## Files referenced in this proposal

For quick navigation in the next session:

- Schema: `prisma/schema.full.prisma` (never edit `schema.prisma`, it's generated)
- Article service: `src/server/services/article.service.ts`
  - Upsert create path: ~line 800
  - Upsert update path: ~line 930-1100
  - `updateArticleImageScanStatus` auto-publish: ~line 1678-1733
  - `linkArticleContentImages`: ~line 1428
- NSFW level math: `src/server/services/nsfwLevels.service.ts:280-325`
- Webhooks:
  - `src/pages/api/webhooks/image-scan-result.ts`
  - `src/pages/api/webhooks/text-moderation-result.ts` (entity handler: lines 25-66)
- Backfills:
  - `src/pages/api/admin/temp/migrate-article-images.ts`
  - `src/pages/api/admin/temp/migrate-article-text-moderation.ts`
- Feature flags: `src/server/services/feature-flags.service.ts` (the `articles` entry)
- Extraction (already has parity test locked in): `src/server/services/article-content-cleanup.service.ts`, `src/utils/article-helpers.ts`
- Existing image ingestion pattern to mirror: `Image.ingestion` in schema, `src/server/services/image.service.ts` query sites (line 1535, 4509, 3991, etc.)
