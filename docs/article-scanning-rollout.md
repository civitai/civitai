# Article Content Scanning — Production Rollout Rundown

**PR**: civitai/civitai#1879 (`feature/scan-article-images` → `environment-swap`)
**Companion doc**: [`docs/article-content-scanning.md`](./article-content-scanning.md) (full architecture reference, 1000+ lines)
**Open proposal**: [`docs/article-ingestion-status-proposal.md`](./article-ingestion-status-proposal.md) — architectural gap surfaced during rollout review, see §5.9 below before deploying
**Scope of this doc**: deploy-time context, gotchas, and the deltas that matter *right now*. For the end-to-end architecture, read the companion doc.

> ⚠️ **Read §5.9 before rollout.** A review pass on 2026-04-10 surfaced a real leak window in the current deploy sequence (code ships with `articles: ['public']` before either backfill runs, so Civitai Green sees legacy articles at their pre-scan `nsfwLevel`). The mitigation is either a staged flag flip or a followup `Article.ingestion` refactor — both options are specced out in [`article-ingestion-status-proposal.md`](./article-ingestion-status-proposal.md). Do not merge without picking a path.

---

## 1. TL;DR — what this PR does

Ships the full "articles get scanned like everything else" system and turns it on for Civitai Green:

1. **Image extraction** — every `<img>` / `<edge-media>` inside article HTML is walked out of the Tiptap AST, persisted as `Image` + `ImageConnection` rows, and queued for the standard ingestion pipeline (WD14 / Hive / Clavata / Hash). Cover images already went through this; content images now do too.
2. **Text moderation via xGuard** — on every article create/update, `(title + stripped content)` is fire-and-forget submitted to the orchestrator xGuard workflow with `labels: ['nsfw']`. A content-hash on `EntityModeration` dedupes unchanged text.
3. **Composite NSFW level** — `updateArticleNsfwLevels` now folds cover image + content images + `userNsfwLevel` + `article.nsfw` into a single `nsfwLevel` mask. When text moderation flips `article.nsfw = true`, the level is written as `nsfwBrowsingLevelsFlag` so the standard `(nsfwLevel & browsingLevel) != 0` filter handles serving-path filtering.
4. **Serving-path hygiene for Civitai Green** — closed every read path that previously ignored `nsfwLevel` on articles (`getCivitaiNews`, `getCivitaiEvents`, `getArticleById`, `sitemap-articles.xml`, `/api/og`) so articles can be served to the `public` audience safely.
5. **Profanity filter retired from articles** — orchestrator text moderation supersedes the lexical profanity keyword filter. `ArticleMetadata.profanityMatches`/`profanityEvaluation` fields were removed; the legacy `migrate-profanity-nsfw.ts` admin backfill no longer accepts `entity=articles` (models + bounties still use it).
6. **Backfill endpoints** — `migrate-article-images.ts` backfills image links, `migrate-article-text-moderation.ts` backfills xGuard submissions. Both are cancellable on client disconnect.

**Feature flag state on this branch**:

| Flag | Value | Effect |
|---|---|---|
| `articles` | `['public']` | Articles are served to Civitai Green (was `['blue','red','public']`) |
| `articleCreate` | `['public']` | Creation open to all |
| `articleImageScanning` | `['public']` | Image-scan pipeline + webhook debounce active for everyone |

---

## 2. What changed *since* the companion doc was written (2026-04-07)

The companion doc is comprehensive but pre-dates the last four commits on the branch. If you only read that doc, you will miss these:

### 2.1 Handler dispatch for text moderation was just re-enabled (commit `7d47f8546`)

**This is the most important rollout line item.**

Before this commit, `src/pages/api/webhooks/text-moderation-result.ts:111-124` had the entity-handler dispatch commented out behind a `// TODO: Re-enable once we've validated EntityModeration data` block. That meant:

- `EntityModeration` rows were being recorded (`status: Succeeded`, `blocked`, `triggeredLabels`, `result` JSON all populated)
- **But no downstream enforcement ran**: `article.nsfw` was never flipped, `updateArticleNsfwLevels` was never called from the webhook, and `UnpublishedViolation` auto-unpublish never fired

After deploying this branch:

- Every incoming xGuard success event invokes the `Article` handler in `entityHandlers`
- On any `blocked || labels includes 'nsfw'`, the article gets `nsfw: true` + recomputed `nsfwLevel`
- On `blocked === true`, the article's `status` flips to `UnpublishedViolation` and the owner receives a `system-message` notification with key `article-text-blocked-<id>`

**Implication**: if production was already receiving xGuard callbacks pre-deploy (e.g. during staged merge testing), those `EntityModeration` rows are recorded but their enforcement never ran. Re-running the text-moderation backfill post-deploy will re-submit articles whose status is not `Succeeded` — but **articles that already have a successful `EntityModeration` will NOT be re-enforced** because the backfill's `WHERE em.status != 'Succeeded'` clause skips them. See §5.2 for the mitigation.

### 2.2 Text moderation simplified to `['nsfw']`-only labels (commit `0403abecb`)

The original design mapped individual xGuard labels (`sexual`, `hate`, `violence`, etc.) to specific `NsfwLevel` values via `mapTriggeredLabelsToNsfwLevel`. That's gone. Now:

- Article create/update, the retry job, and the backfill all submit with `labels: ['nsfw']`
- The webhook `Article` handler treats the result as a binary — `blocked || triggeredLabels.includes('nsfw')` → `article.nsfw = true`
- **Elevation only**: never downgrades. An article flipped NSFW by text can't be un-NSFW'd by text moderation (only by moderator action or image-side recalculation).

The companion doc's "Label-to-NsfwLevel mapping" table (lines 358–372) is **stale** and should be ignored for articles. Models/bounties/etc. may still use the old path.

### 2.3 NSFW aggregation changed from `bit_or` → `GREATEST(max(...))`  (commit `28b38c7dd`)

`updateArticleNsfwLevels` in `src/server/services/nsfwLevels.service.ts:280` used to `bit_or` the cover image level with a `bit_or` of all content image levels. That was a correctness bug: `NsfwLevel` values are powers of two (PG=1, PG13=2, R=4, X=8, XXX=16), so `bit_or`ing a PG (1) image with an R (4) image produced `5`, and `5 & publicBrowsingLevelsFlag (1)` is non-zero, so the article leaked through public filters.

The fix uses `GREATEST(max(cover), max(content))` — integer max over powers-of-two == highest rating. Single-bit output, no multi-bit leaks.

**Implication for deploy**: running `updateArticleNsfwLevels` over legacy articles (which happens implicitly when backfills complete) will **change existing masks** for any article that mixed PG + NSFW content images under the old code. Watch the articles Meilisearch index for re-index churn during the backfill. This is expected.

### 2.4 `article.nsfw` folds into `nsfwLevel` via `CASE WHEN`

Same commit. The UPDATE at `nsfwLevels.service.ts:315-325` now does:

```sql
SET "nsfwLevel" = (
  CASE
    WHEN a.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
    ELSE GREATEST(a."userNsfwLevel", level."nsfwLevel")
  END
)
```

So the text-moderation webhook only needs to set `article.nsfw = true` and call `updateArticleNsfwLevels([id])` — the CASE branch handles the rest. This matches how `updateModelNsfwLevels` / `updateBountyNsfwLevels` already worked.

### 2.5 Articles feature flag opened to `['public']`

Civitai Green now serves articles. This is **intentionally bundled** with the read-path hygiene fixes in commit `28b38c7dd` — they ship together or not at all. Do not ship one without the other.

### 2.6 `migrate-profanity-nsfw.ts` dropped the articles entity (commit `81e3efbc2`)

Not a rollout concern, but noted for completeness: because `ArticleMetadata.profanityMatches`/`profanityEvaluation` were removed, the articles branch of the legacy profanity admin backfill failed typecheck. The entire articles branch was removed. Models and bounties still work.

---

## 3. Pre-rollout checklist

Before merging and deploying:

- [ ] **`TEXT_MODERATION_CALLBACK` env var is set in production** (`src/env/server-schema.ts:97` — optional in schema, required at runtime). xGuard needs to know where to POST results. Without it, `EntityModeration` rows will pile up in `Pending` forever.
- [ ] **Redis is reachable** — webhook debounce (`src/server/utils/webhook-debounce.ts`, 5-second window) uses Redis. Without Redis, debounce degrades to per-webhook DB updates — functional but expensive under scan burst.
- [ ] **Orchestrator client is healthy** — `internalOrchestratorClient` is used by both submission and `getWorkflow` in the webhook. If it's unreachable, submissions will log to Axiom (`article-text-moderation`) and webhook processing will 400.
- [ ] **Feature flag review** — confirm `articles: ['public']`, `articleCreate: ['public']`, `articleImageScanning: ['public']` in `feature-flags.service.ts` are the intended values for this cut. All three are set on this branch.
- [ ] **`retry-failed-text-moderation` job is scheduled** — cron `*/15 * * * *`, defined in `src/server/jobs/text-moderation-retry.ts`. Verify it's registered in the job runner. Picks up Failed/Expired/Canceled workflows after 60 min, stuck Pending after 30 min, retry cap 9.
- [ ] **Axiom dataset contains expected streams**: `article-text-moderation`, `article-image-linking`, `text-moderation-result`, `article-image-scan`.
- [ ] **Staging dry-run of both backfills** — at minimum run each with `dryRun=true` and confirm the logged counts look sane before flipping `dryRun=false`.

---

## 4. Rollout sequence

This is the order to run on production. Each step is individually rollback-able; don't batch them.

### Step 1 — Deploy the code

Ship the branch. With the feature flags already at `['public']`, this turns on:

- Image extraction + scan queue on every new/edited article
- xGuard submission on every new/edited article
- Webhook enforcement (handler dispatch is now live)
- The new `updateArticleNsfwLevels` math
- Civitai Green serving of articles

**Expected immediate behavior**:

- New articles created after deploy will go `Draft → Processing → Published` (image pipeline gates Processing→Published; text moderation runs in parallel, non-gating).
- New article text is submitted to xGuard within the upsert tRPC call, fire-and-forget.

### Step 2 — Backfill image links (idempotent, resumable)

Populates `ImageConnection` rows and recomputes `nsfwLevel` for every existing article:

```bash
# Start with dry-run at low concurrency
curl "https://civitai.com/api/admin/temp/migrate-article-images?dryRun=true&concurrency=2"

# Then the real run
curl "https://civitai.com/api/admin/temp/migrate-article-images?dryRun=false&concurrency=2"
```

- **Mode is now image-scan only.** The `mode=` parameter described in the companion doc (§Deployment) was split off in commit `0403abecb`. Text moderation is handled by a separate endpoint (§Step 3).
- Cancelable: closing the HTTP request cancels in-flight `pgDbRead` queries cleanly.
- Watch Axiom (`article-image-scan` / `article-image-linking`) for errors.
- Expect legacy articles' `nsfwLevel` to change (see §2.3). This is correct.

### Step 3 — Backfill text moderation

Submits every Published article without a `Succeeded` `EntityModeration` row to xGuard:

```bash
# Dry-run first
curl "https://civitai.com/api/admin/temp/migrate-article-text-moderation?dryRun=true&concurrency=5"

# Then the real run (priority: low so it doesn't starve synchronous submissions)
curl "https://civitai.com/api/admin/temp/migrate-article-text-moderation?dryRun=false&concurrency=5"
```

- Endpoint: `src/pages/api/admin/temp/migrate-article-text-moderation.ts`
- `concurrency` is capped at 5 (schema), `batchSize` at 1000.
- Batch-by-batch cursor walk with `pgDbRead.cancellableQuery`. Safe to interrupt and resume (restart with `?start=<lastCursor>`).
- Skips articles with `content = ''` and articles already `Succeeded`.
- **Does not** re-submit articles that already have a `Succeeded` `EntityModeration` — see §5.2 if you need to force re-enforcement.
- Backfill submissions use `priority: 'low'` to avoid starving the synchronous submission queue from new article saves.

### Step 4 — Monitor for 24h

See §6 for the monitoring queries.

---

## 5. Gotchas and things to keep in mind

### 5.1 Auto-unpublish is now user-visible

With the webhook handler re-enabled, a blocked text moderation result flips `status = UnpublishedViolation` and sends a `system-message` notification to the author:

> "Your article was unpublished because its content violates our Terms of Service."

**False positives are possible and visible.** If xGuard returns `blocked: true` incorrectly, the article owner gets notified. Moderators can restore via `restoreArticleById`. Watch the first 24h closely for notification bursts — especially since the backfill will submit every historical article at once.

**Consider**: running the text-moderation backfill with a narrow date range first (`?after=2026-04-01`) to bound the blast radius, then expand.

### 5.2 Articles with stale `Succeeded` EntityModeration will NOT be re-enforced by the backfill

If any xGuard callbacks hit production *before* this deploy while the handler was stubbed out, those articles now have:
- `EntityModeration.status = Succeeded`
- `EntityModeration.blocked = true` (in some cases)
- But `Article.nsfw = false` and `Article.status = Published`

The backfill's `WHERE em.status != 'Succeeded'` clause skips these. To remediate, run this one-off query (read first, then decide):

```sql
-- Find previously-blocked articles that were never enforced
SELECT em."entityId", a.title, a.status, a.nsfw, em."updatedAt"
FROM "EntityModeration" em
JOIN "Article" a ON a.id = em."entityId"
WHERE em."entityType" = 'Article'
  AND em.status = 'Succeeded'
  AND em.blocked = true
  AND a.status != 'UnpublishedViolation';
```

If the list is small and the `blocked` verdicts are trustworthy, enforce manually via moderator tools or a targeted script. Do **not** just flip statuses blindly — at minimum reconfirm the `triggeredLabels` and `result` JSON first.

### 5.3 Content hash dedupe will block re-moderation

`submitTextModeration` computes SHA-256 over `(title + stripped content)` and compares against `EntityModeration.contentHash`. If unchanged, the submission is a no-op. This means:

- Editing only the cover image or tags → no re-submission (correct, desired)
- xGuard recalibration → existing articles won't be re-scored **even if you resubmit**

If you need to force re-moderation across the corpus (e.g., after a classifier update), you must `UPDATE "EntityModeration" SET "contentHash" = NULL, status = 'Pending' WHERE "entityType" = 'Article'` before running the backfill. Coordinate with the orchestrator team before doing this — it will fan out a large submission burst.

### 5.4 Webhook debounce hides per-image observability

`debounceArticleUpdate` coalesces up to 50 image webhooks → 1 article update over a 5-second window. You will **not** see per-image entries in the article update audit trail, only the coalesced aggregate. When debugging a specific image, query `Image.ingestion`/`Image.nsfwLevel` directly rather than trying to reconstruct from the article's update history.

### 5.5 nsfwLevel mask shape change is a one-way migration

Old articles that mixed PG and NSFW content images have multi-bit masks like `5` (PG | R). The new `GREATEST(max())` math produces single-bit masks. Once the backfill rewrites these rows, the old masks are gone. There is no "rollback nsfwLevel calculation" path without restoring from a DB snapshot — the commit is non-reversible *for data*. Code can still be reverted; the data cannot.

### 5.6 Tiptap extraction walks both JSON and HTML

`getContentMedia` at `src/server/services/article-content-cleanup.service.ts` tries Tiptap JSON first (content starts with `{`), otherwise parses HTML via `@tiptap/html/server`'s `generateJSON`. The client-side `extractImagesFromArticle` uses browser `DOMParser`. If the two ever drift, the UI scan-status hook and the server-side linker will disagree. Spot-check one known-good article after deploy.

### 5.7 `Processing` is a new enum value, but it's owner/mod-only — `status === 'Published'` filters are correct

`ArticleStatus.Processing` is **new to this branch** (introduced in `prisma/schema.full.prisma` on `feature/scan-article-images`; it doesn't exist on main). Articles land in `Processing` when they have `Pending` content images that haven't finished scanning yet.

**Visibility**: `Processing` behaves like a hidden state from the public's perspective. Confirmed gating:

- `getArticles` (`src/server/services/article.service.ts:257`) — non-owner, non-mod callers get `a.status = 'Published'` hard-filtered into the SQL WHERE clause.
- `getArticleById` (`src/server/services/article.service.ts:639-641`) — non-mod callers see an article only if `status = Published` **or** they're the owner; otherwise 404.
- `articles.search-index.ts:175` — Meilisearch pull is scoped to `status = Published`, so Processing articles are not indexed or searchable.
- Feeds, sitemap, OG cards, `getCivitaiNews`, `getCivitaiEvents` all flow through the same `getArticles`-style gates.

**Therefore**: downstream code that filters `status === 'Published'` is **correct and intended**. Do not "audit" it. The contract is: Processing is an internal transient state, owner + mods only, eventually becomes Published (or stays Processing indefinitely if scans genuinely fail, which is a separate operational concern covered in §6).

**The real gotchas around Processing** (keep these in mind):

1. **Re-scan temporarily hides already-published articles from the public.** When an author edits a previously-Published article and the edit introduces new unscanned images, the upsert path flips status back to `Processing` while preserving `publishedAt` (`article.service.ts:953`). During the scan window, the article is invisible to everyone except the author and mods, even though its `publishedAt` is unchanged. Authors may report "my article disappeared after I edited it" — this is working as designed. The `ArticleScanStatus` component in the upsert form surfaces the state to the author.

2. **New enum value propagation.** Anything that mirrors the `ArticleStatus` enum outside the main Prisma schema (replicas, Metabase/ClickHouse ETL, analytics dashboards, TypeScript-generated clients consumed by other services, external OpenAPI specs) will see a value it doesn't recognize. Check before deploy:
   - ClickHouse/Metabase article status breakdowns
   - Any consumer of the REST/tRPC article endpoints that casts to its own enum
   - Moderator tooling that lists articles by status — does it render `Processing` gracefully?

3. **Articles stuck in `Processing` are invisible silent failures.** Because they don't appear in public feeds, a scan pipeline outage manifests as authors reporting "my article won't publish" rather than as public-facing errors. Watch the stuck-Processing query in §6 closely during the first 24h.

### 5.8 Profanity filter removal is irreversible-in-this-branch

`ArticleMetadata.profanityMatches` and `profanityEvaluation` are gone from the type. Any code in `environment-swap` or `main` that read these fields will fail typecheck post-merge. Grep for references before merging:

```bash
git grep -E "profanityMatches|profanityEvaluation" -- 'src/**/*.ts' 'src/**/*.tsx'
```

As of this branch, only `migrate-profanity-nsfw.ts` (models + bounties sections) references them.

### 5.9 ⚠️ Legacy articles are exposed to Civitai Green before backfills run

**This is the most important gotcha on the page. It was missed on the first review pass and surfaced on 2026-04-10.** Don't deploy this branch until a decision has been made on how to handle it. Full analysis and proposed fix: [`article-ingestion-status-proposal.md`](./article-ingestion-status-proposal.md).

**The gap**: the current rollout sequence (§4) deploys code with `articles: ['public']` **before** either backfill runs. At that moment, every legacy article becomes visible to Civitai Green at its pre-scan `nsfwLevel` — which was computed from cover image + `userNsfwLevel` only, because `ImageConnection` rows for content images don't exist yet and `article.nsfw` from text moderation hasn't been set. So a legacy article with a PG cover, NSFW content images embedded in the body, and NSFW prose is currently classified `nsfwLevel = PG` and will be happily served to Green for the entire duration of the backfill window.

§2.3 of this doc already acknowledges that "running `updateArticleNsfwLevels` over legacy articles will change existing masks for any article that mixed PG + NSFW content images under the old code." Every article whose mask **changes** during the backfill was being served at the wrong level **before** the backfill ran. That's the leak.

**Two paths to fix it**, both specced out in [`article-ingestion-status-proposal.md`](./article-ingestion-status-proposal.md):

1. **Path A — Staged flag flip (operational, no code changes).** Ship this branch with `articles: ['blue','red','public']` (pre-branch state). Deploy, run both backfills to completion, then flip `articles: ['public']` in a followup deploy. Cheap. Requires two deploys and a manual wait-for-backfill step. Followup ticket: implement the `Article.ingestion` refactor (Path B) so the next article rollout doesn't have this problem.

2. **Path B — `Article.ingestion` refactor (architectural).** Add an `ArticleIngestionStatus` enum + `Article.ingestion` column modeled after `Image.ingestion`. Serving paths filter on `ingestion = 'Scanned'` for public/Green viewers. Legacy migration defaults everything to `Pending` → every legacy article is immediately invisible to Green. Backfills flip articles to `Scanned` one at a time as both image and text scans complete. Self-gating, no staged flag flip needed. Bigger PR surface area (several hundred lines + schema migration + serving gates across ~6 read sites). Also closes the live async text-scan window from the 2026-04-10 decision without the UX cost that killed Option A.

**Decision criteria**: run this against prod before picking a path —

```sql
SELECT
  COUNT(*) AS total_articles,
  COUNT(*) FILTER (WHERE status = 'Published') AS published,
  COUNT(*) FILTER (WHERE status = 'Published' AND content != '') AS published_with_content,
  COUNT(*) FILTER (WHERE status = 'Published' AND "contentScannedAt" IS NULL) AS unscanned_published
FROM "Article";
```

Small corpus → Path A is fine. Large corpus → Path B pays for itself.

**Also re-confirm**: was `articles: ['public']` the state on `main` before this branch opened it? Check `git blame` on `src/server/services/feature-flags.service.ts`. If Green already saw articles on `main`, the framing shifts from "this branch opens legacy content to Green" to "this branch changes which legacy articles are visible to Green", which changes the urgency but not the fact that the leak window exists.

---

## 6. Monitoring (first 24h)

### Axiom streams to tail

| Stream | What to watch for |
|---|---|
| `article-text-moderation` | Error count for synchronous submissions from `upsertArticle` |
| `article-image-linking` | Failures linking extracted images (non-blocking, but indicates bad content) |
| `text-moderation-result` | `Stale workflow callback ignored` warnings (benign), `Workflow failed/expired` errors, unexpected statuses |
| `article-image-scan` | Scan completion rate, error count, processing status transitions |

### Postgres sanity queries

```sql
-- Text moderation backlog — should drain steadily
SELECT status, COUNT(*)
FROM "EntityModeration"
WHERE "entityType" = 'Article'
GROUP BY status;

-- Articles stuck in Processing — should not grow unbounded
SELECT COUNT(*) FROM "Article" WHERE status = 'Processing';

-- Articles with Pending image connections still in Processing — find stuck ones
SELECT a.id, a.title, COUNT(*) AS pending_images
FROM "Article" a
JOIN "ImageConnection" ic ON ic."entityId" = a.id AND ic."entityType" = 'Article'
JOIN "Image" i ON ic."imageId" = i.id
WHERE a.status = 'Processing' AND i.ingestion = 'Pending'
GROUP BY a.id, a.title
ORDER BY pending_images DESC
LIMIT 20;

-- Recent auto-unpublish events from text moderation
SELECT em."entityId", a.title, em."triggeredLabels", em.blocked, em."updatedAt"
FROM "EntityModeration" em
JOIN "Article" a ON a.id = em."entityId"
WHERE em."entityType" = 'Article'
  AND em.blocked = true
  AND em."updatedAt" > NOW() - INTERVAL '24 hours'
ORDER BY em."updatedAt" DESC;

-- Articles whose nsfwLevel changed recently (to spot migration churn)
SELECT COUNT(*)
FROM "Article"
WHERE "updatedAt" > NOW() - INTERVAL '1 hour';
```

### Key alerts to set (if not already)

- `EntityModeration.Pending` older than 1h, count > 100 → orchestrator is backlogged or callback is broken
- `Article.status = 'Processing'` older than 30min, count > 50 → image scan queue is backed up
- Spike in `status = 'UnpublishedViolation'` — possible xGuard false-positive burst; consider temporarily rolling back the handler dispatch

---

## 7. Rollback procedures

Ordered from fastest (lowest impact) to nuclear.

### 7.1 Disable image scanning pipeline (no code)

Toggle `articleImageScanning` in `feature-flags.service.ts`:

```ts
articleImageScanning: [], // was ['public']
```

**Effect**:
- New articles still save, still submit to text moderation, but `debounceArticleUpdate` in `image-scan-result.ts` short-circuits
- Articles already in `Processing` will **not** auto-transition to `Published` — they need manual intervention or the flag re-enabled
- Existing NSFW levels stay as-is

### 7.2 Disable text moderation enforcement (requires code change)

Re-comment the handler dispatch block in `src/pages/api/webhooks/text-moderation-result.ts:114-123`:

```ts
// const handler = entityHandlers[entityType];
// if (handler) {
//   await handler({ ... });
// }
```

**Effect**:
- xGuard continues submitting, `EntityModeration` rows continue being written with full results
- No `article.nsfw` flips, no `updateArticleNsfwLevels` calls, no `UnpublishedViolation` transitions
- Previously-enforced articles stay as they are — not auto-restored

This is what to do if you see a false-positive burst and need to stop the bleeding immediately.

### 7.3 Restrict articles back to Civitai Blue/Red

```ts
articles: ['blue', 'red', 'public'], // revert to pre-branch
```

**Effect**: removes Civitai Green access to articles, reverts the rollout scope for this feature. Image scanning and text moderation continue running for existing audiences.

### 7.4 Full revert

Revert the branch merge. Note that:
- **Data changes from §2.3 (nsfwLevel mask shape) do NOT roll back** — they're already persisted in the DB. Post-revert, the old `bit_or` code will see single-bit masks and behave correctly on them, but there's no harm done either way.
- **`EntityModeration` rows stay.** The table is not dropped.
- **`ImageConnection` rows stay.** The new content image links remain in the DB; without the linking code running, new edits won't maintain them but old ones are fine.
- Restoring articles auto-unpublished by text moderation is a manual moderator action.

---

## 8. Contacts / runbook pointers

- **Companion architecture doc**: [`docs/article-content-scanning.md`](./article-content-scanning.md)
- **xGuard orchestrator workflows**: `src/server/services/orchestrator/orchestrator.service.ts`
- **Retry job**: `src/server/jobs/text-moderation-retry.ts` (`*/15 * * * *`)
- **Webhook endpoints**: `src/pages/api/webhooks/image-scan-result.ts`, `src/pages/api/webhooks/text-moderation-result.ts`
- **Backfill endpoints** (`WebhookEndpoint`-gated): `/api/admin/temp/migrate-article-images`, `/api/admin/temp/migrate-article-text-moderation`
- **Flipt flag**: `articleImageScanning` is feature-flag gated in code (not Flipt). To change, edit `feature-flags.service.ts` and redeploy.

---

**Doc owner**: whoever merges civitai/civitai#1879
**Last updated**: 2026-04-10
