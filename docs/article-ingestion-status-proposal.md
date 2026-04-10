# Article Ingestion Status — Design Proposal

**Status**: Draft, pending implementation decision
**Context**: Surfaced during review of [`article-scanning-rollout.md`](./article-scanning-rollout.md) on 2026-04-10
**Related**: civitai/civitai#1879 (`feature/scan-article-images`), [`article-content-scanning.md`](./article-content-scanning.md)

---

## TL;DR

Add an `ArticleIngestionStatus` enum + `Article.ingestion` column that mirrors how `Image.ingestion` already gates image serving. Non-owner, non-moderator article reads filter on `ingestion = 'Scanned'`. This:

1. Closes the legacy-backfill Green exposure window (the real gap I missed in the initial gotchas review).
2. Supersedes the accepted async text-scan window decision from 2026-04-10 — not by reversing it, but by offering a gating mechanism the earlier discussion didn't consider.
3. Unifies image and text scan gating under a single predicate.
4. Separates scan state (system) from publication state (user intent), which removes most of the awkwardness around `ArticleStatus.Processing`.

**Decision pending**: ship this as a followup (recommended) vs. absorb into the current PR (bigger scope, cleaner landing).

---

## The problem this solves

### Gap 1 — Legacy backfill exposes unscanned content to Civitai Green

The current rollout sequence (§4 of `article-scanning-rollout.md`) is:

1. Deploy code — feature flags already at `articles: ['public']` → Civitai Green starts serving the entire legacy article corpus immediately.
2. Run image backfill (`migrate-article-images.ts`).
3. Run text moderation backfill (`migrate-article-text-moderation.ts`).

Between steps 1 and 2, a legacy article's `nsfwLevel` is computed from **just** cover image + `userNsfwLevel` — because `ImageConnection` rows for content images don't exist yet, so `GREATEST(max(cover), max(content))` in `updateArticleNsfwLevels` has nothing to max over on the content side. `article.nsfw` is also still `false` because text moderation hasn't run.

So a legacy article with a PG cover, NSFW content images embedded in the body, and NSFW text currently has `nsfwLevel = PG`. After step 1 deploys, Civitai Green filters by `(nsfwLevel & publicBrowsingLevelsFlag) != 0` and happily serves that article. The backfills eventually fix it, but the entire legacy corpus is visible to Green at its **pre-scan** level for the duration of the backfill window.

The commit message for `28b38c7dd` acknowledges that legacy masks are wrong and will be updated by the backfill. `article-scanning-rollout.md` §2.3 calls this out directly: "running `updateArticleNsfwLevels` over legacy articles (which happens implicitly when backfills complete) will change existing masks for any article that mixed PG + NSFW content images under the old code." Any article whose mask *changes* during the backfill was being served at the wrong level *before* the backfill ran. That's the leak window.

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
  ingestion ArticleIngestionStatus @default(Pending)

  @@index([status, ingestion, nsfwLevel])  // supports the Green query shape
}
```

**Migration**: adds the column with `@default(Pending)`. Every existing article is `Pending` on schema apply — **every legacy article is immediately invisible to Civitai Green the moment the migration runs.** That's the safety property we want.

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

  await dbWrite.article.update({
    where: { id: articleId },
    data: { ingestion: next },
  });
}
```

**Important edge case**: a brand-new article with no content images and text moderation pending is `imageDone=true` (no images to wait on) but `textDone=false`, so it correctly stays `Pending`. Don't let the `noImages` shortcut mark it Scanned.

**Call sites for the helper**:

- `src/pages/api/webhooks/image-scan-result.ts` — after each image scan result is processed (it already queries which articles the image belongs to for the debounce logic)
- `src/pages/api/webhooks/text-moderation-result.ts` — inside the `Article` entity handler, after `recordEntityModerationSuccess`/`Failure`
- `src/server/services/article.service.ts` upsert path — after `linkArticleContentImages` + `submitTextModeration` (handles the "new article with no images, text pending" base case — writes `ingestion: Pending` explicitly)
- `src/pages/api/admin/temp/migrate-article-images.ts` — at the end of each processed article
- `src/pages/api/admin/temp/migrate-article-text-moderation.ts` — **not** strictly needed because the text backfill just submits to xGuard; the webhook handler is what updates state when xGuard responds

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

The migration with `@default(Pending)` is the key mechanism:

1. **Schema apply** — every existing article becomes `ingestion = Pending`. Civitai Green instantly loses visibility of the entire legacy corpus. No staged flag flip required; the migration itself is the safety gate.
2. **Image backfill runs** — for each article: extract media, create `ImageConnection` rows, kick off image scans. At the end of each article, call `recomputeArticleIngestion(id)`. Articles with no content media transition toward `Scanned` if text side is also done; articles with content media stay `Pending` until the async image scans complete.
3. **Image scan webhooks** — as each content image completes scanning, the webhook calls `recomputeArticleIngestion(articleId)`. Articles whose last image just finished (and whose text is already Succeeded) flip to `Scanned` and become visible to Green.
4. **Text backfill runs in parallel** — submits each article to xGuard. The webhook handler (already live on this branch) calls `recomputeArticleIngestion` after processing the xGuard response. Articles whose text just finished (and whose images are already done) flip to `Scanned`.
5. **Articles light up for Green one at a time**, as each finishes *both* sides. No cliff-edge "all of prod becomes visible at once" moment.

Compare to the operational mitigation I originally recommended (staged flag flip): that mitigation requires two deploys and a manual wait-for-backfill step, and gives you a single cliff where Green becomes visible. The ingestion refactor gives you gradual, self-gated exposure with one deploy.

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
| Schema migration | `prisma/schema.full.prisma`, generated migration SQL | ~20 |
| Helper function | `src/server/services/article.service.ts` | ~50 |
| Webhook wiring | `image-scan-result.ts`, `text-moderation-result.ts` | ~15 |
| Serving gates | ~6 read sites + Meilisearch index filter | ~50 |
| Remove Processing from auto-publish | `article.service.ts` `updateArticleImageScanStatus` | ~15 |
| Upsert path wiring | `article.service.ts` create + update branches | ~15 |
| Re-scan path | `article.service.ts` upsert status-flip logic | ~10 |
| Backfill wiring | `migrate-article-images.ts` | ~10 |
| Tests | new tests for `recomputeArticleIngestion` transitions | ~150 |

A few hundred lines across ~15 files + one DB migration. Doable in a session or two of focused work. The existing parity test from the current PR (`src/utils/__tests__/article-extraction-parity.test.ts`) is unaffected.

---

## Open questions to resolve before writing code

1. **Author-facing UI impact** — the `ArticleScanStatus` component in `ArticleUpsertForm.tsx` currently reads `article.status === Processing` to show scan progress. Does it need to switch to reading `article.ingestion === Pending`? If so, what does the author see while text is still scanning but images are done? (Current behavior on text-only articles: nothing — they publish instantly. New behavior: they see a "text scan pending" indicator?) This is the one place where the 2026-04-10 UX concern could resurface. The solution is probably to keep the author-facing indicator quiet for text-only articles and only surface it when the delay exceeds some threshold, or when scan fails.

2. **`article.nsfw` text-moderation flag** — still needed or subsumed by `ingestion = Blocked`? Keep both. They track different axes: `nsfw` = "text contains NSFW content, elevate the mask", `ingestion = Blocked` = "text violated ToS, hide from everyone except mods". The webhook handler already sets `nsfw = true` for NSFW labels without blocking, and only flips `status = UnpublishedViolation` for `blocked = true`. That stays the same; we just add the ingestion update alongside.

3. **Rescan visibility** — when an author edits a Published article and adds new content, should the article stay visible at the old nsfwLevel until the new scan completes, or should it immediately disappear from Green? The safe answer is "disappear" (flip `ingestion = Rescan`, serving gate hides it). The status-quo-preserving answer is "stay visible at old level" (don't flip ingestion until the new scan completes, at which point update in place). Safe is better for a rollout; revisit later if authors complain.

4. **Processing auto-publish notification** — the "Your article has been published successfully!" message fires on Processing → Published transition. Under the new model: does it fire on `ingestion = Scanned`? Or drop it entirely because the author never saw a "processing" state to begin with? Probably drop it — we're making the scan gate invisible, so a "finished scanning" notification is noise. Except for text-only articles that went through the scan window: those users never expected to see a notification, so dropping is consistent.

5. **Moderation tooling** — any admin UI that filters articles by status. Does it need an ingestion filter too? Probably not — mods should see everything by default, but a "show me articles stuck in Pending" filter might be useful for debugging scan pipeline issues. Add in a followup if requested.

6. **Index choice** — `@@index([status, ingestion, nsfwLevel])` is one option. The actual best index depends on query patterns. Check `getArticles` query plans before committing to a specific shape; a partial index on `(ingestion, nsfwLevel) WHERE status = 'Published'` might be better if most Green queries also filter to Published.

---

## Two paths forward

### Path A — Ship this PR as-is with staged flag flip, ingestion refactor as immediate followup (recommended)

1. On `feature/scan-article-images`: change `articles` flag from `['public']` to `['blue','red','public']` (pre-branch state, no Green exposure).
2. Merge and deploy. Code goes live; new-article image scan + text moderation + webhook enforcement all activate. Green still doesn't see articles.
3. Run image backfill to completion.
4. Run text-moderation backfill to completion.
5. Flip `articles` to `['public']` in a small followup deploy. Green gains access to the now-scanned legacy corpus.
6. **Immediately start the ingestion refactor** as a separate PR using this doc. Merge before the next meaningful feature work on articles so the scan gate is in place for future changes.

**Pros**: minimal scope for current PR, rollout can proceed this week, ingestion refactor gets the attention it deserves in its own review.
**Cons**: two deploys instead of one, manual "wait for backfill" step, brief Green-disabled window for Civitai Green users who would otherwise see articles.

### Path B — Absorb the ingestion refactor into this PR

1. On `feature/scan-article-images`: add the schema, helper, webhook wiring, serving gates, all the things.
2. Merge and deploy. Migration applies → every legacy article becomes `Pending` → Green sees nothing immediately.
3. Backfills run. Articles light up one at a time as they finish both scan sides.
4. No staged flag flip required.

**Pros**: one clean landing, self-gated rollout, closes both the legacy gap and the live async window in one shot.
**Cons**: significantly larger PR surface area (several hundred lines + DB migration + serving-path changes across many files), higher risk of missing a read site, need to re-review everything, delays the merge.

### Decision criteria

The single most important data point for choosing: **how many legacy articles are in prod?**

- **If the corpus is small** (~tens of thousands): Path A is obviously fine. The backfill drains fast, the brief Green-disabled window is negligible, and the ingestion refactor can be cleaned up later without pressure.
- **If the corpus is large** (hundreds of thousands or millions): Path B pays for itself because the self-gating eliminates the "wait for backfill" dance and gives operators a much nicer rollout experience. The one-clean-landing argument also gets stronger because you don't want to ship a rushed ingestion refactor on top of a rollout that's still settling.

Run this before deciding:

```sql
SELECT
  COUNT(*) AS total_articles,
  COUNT(*) FILTER (WHERE status = 'Published') AS published,
  COUNT(*) FILTER (WHERE status = 'Published' AND content != '') AS published_with_content,
  COUNT(*) FILTER (WHERE status = 'Published' AND "contentScannedAt" IS NULL) AS unscanned_published
FROM "Article";
```

---

## Next-session checklist

When picking this up fresh:

- [ ] Run the corpus-size query above to confirm Path A vs Path B.
- [ ] Confirm the historical Green state — did `articles: ['public']` on `main` already mean Green sees articles, or is this branch opening Green access for the first time? Check git blame on `src/server/services/feature-flags.service.ts` for the `articles` entry. If Green already sees articles on `main`, the whole "legacy exposure" framing is softer because the corpus is already exposed; the concern narrows to "new leaks *enabled* by the branch", which is different.
- [ ] Re-read the 2026-04-10 decision in `~/.claude/projects/-Users-hackstreetboy-Projects-civitai/memory/project_article_text_scan_window.md`. Confirm that this proposal genuinely doesn't re-open it — specifically verify that the author-facing UX stays "instant publish" (Open Question 1 above).
- [ ] Decide between Path A and Path B based on corpus size + team appetite for scope.
- [ ] If Path A: make the flag change on the branch, add a note to §4 of `article-scanning-rollout.md` documenting the staged flag flip procedure, and create a followup ticket/branch for the ingestion refactor.
- [ ] If Path B: start with the schema migration commit, then the helper + webhook wiring commit, then the serving-gates commit (with a careful grep sweep for every article read site), then the Processing-removal commit. Each commit independently reviewable and rollback-able.
- [ ] Either path: the §5.6 parity test (`src/utils/__tests__/article-extraction-parity.test.ts`) and §5.2 stale `Succeeded` re-enforcement fix are still on the table from the original gotchas review. Those can land independently of this proposal.
- [ ] Either path: re-examine the `contentScannedAt` naming. The rename-for-clarity discussion is still outstanding from the earlier session.

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
