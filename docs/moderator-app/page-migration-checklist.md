# Moderator App — Page Migration Checklist

Tracking the migration of moderator pages from the main Civitai Next.js app
(`src/pages/moderator/**`) into the standalone SvelteKit app (`apps/moderator`).

## How to read this

The new app uses **Kysely** (via `@civitai/db/kysely`) — **no tRPC, no Prisma engine**. So
migrating a page is not just porting a React component; it means recreating the page's entire
**backend slice** as SvelteKit `load` functions / form actions backed by Kysely queries:

- **tRPC procedures** → SvelteKit `+page.server.ts` `load` (queries) and form `actions` (mutations).
- **Services/methods** → ported service functions (Prisma → Kysely), living in `apps/moderator/src/lib/server/`.
- **Schemas** → the zod input contracts, reusable on the server (and for client form validation).
- **Infra** → whichever `@civitai/*` packages must be pulled in (`@civitai/redis`, `@civitai/clickhouse`, S3 helpers, orchestrator client, email, etc.). Pull only what a page needs (cherry-pick model — see [new-app-integration.md](../packages/new-app-integration.md)).

Each page is a checkbox. Sub-bullets list the procedures, services, schemas, and infra to recreate.

---

## Migration order (suggested)

Roughly easiest → hardest, and front-loading the **shared services** that many pages depend on:

1. **Postgres-only, read-mostly** pages (blocklists, reports, articles, announcements, rewards, auctions, code-gifts, contests). Low infra, establish the SvelteKit load/action patterns.
2. **Shared service backbone** — `image.service`, `report.service`, `user.service`, `cosmetic-shop.service`, `challenge.service` (see [Shared backend services](#shared-backend-services)). Porting these unblocks whole clusters.
3. **Redis / ClickHouse-backed** pages (scanner-policies, generation-config, service-status, strikes, prompt-audit-test).
4. **Heavy external-integration** pages last (CSAM/NCMEC, buzz-withdrawal/Tipalti/Stripe, cash-management, paddle, training-data/orchestrator, image moderation).

---

## Migrate / Defer / Skip recommendations

Cross-referenced against **`src/components/Moderation/ModerationNav.tsx`** (the live moderator menu).
Five routes are **commented out** in that nav — the team has already hidden them, which is the
strongest skip signal we have. Confirm with the team before deleting outright (a comment may be
temporary), but these should not block the migration.

### Skip — already hidden / superseded / deprecated (commented out in the nav)

| Page | Why skip | Confidence |
|---|---|---|
| `/moderator/buzz-withdrawal-requests` | Deprecated; replaced by `cash-management`. Commented out in nav. | High |
| `/moderator/tags` | Commented out in nav; tag moderation now flows through `/moderator/image-tags`. | High |
| `/moderator/rewards` (index, `create`, `update/[id]`) | All 3 commented out in nav. Purchasable-reward admin is hidden. | Medium — confirm it's not still used via direct URL |
| `/moderator/research/rater-sanity` | Commented out in nav; research/QA tool. | Medium |
| `/moderator/paddle/adjustments` | Commented out in nav; read-only Paddle viewer that could simply stay in the main app. | Medium |

### Skip — dev scaffolds (client-only, no backend, no production value)

| Page | Why skip |
|---|---|
| `/moderator/test`, `/moderator/test2` | UI/slot-system playgrounds. |
| `/moderator/link-demo` | Civitai Link demo. |
| `/moderator/aspect-ratio-explorer` | Client-only AR calculator (in nav, but pure utility — port trivially only if wanted). |
| `/moderator/testing/model3d-seed` | Not in nav; testing/seed tool. Migrate only if 3D-model seeding is still needed. |

### Defer — niche / testing tools (real, but low priority; migrate after the core)

| Page | Note |
|---|---|
| `/moderator/auditor` | In nav, but client-only audit *test* utility (no backend slice). Trivial to port; low value. |
| `/moderator/prompt-audit-test` | Active (csam flag), but a "test" tool; ClickHouse-heavy. Overlaps the suspicious-matches flow. |
| `/moderator/suspicious-audit-matches` | Not in nav (deep-linked from audit tools); niche Redis-list viewer. |
| `/moderator/duplicate-hashes` | Orphaned — not in nav, direct-URL only. Lightweight (single raw SQL) if you do migrate it. |

### Migrate — everything else

All remaining pages are active in the nav (several behind feature flags — `strikes`, `comicCreator`,
`trainingModelsModeration`, `reviewTrainingData`, `serviceStatus`, `cashManagement`, `announcements`,
`blocklists`, `auctionsMod`, `csamReports`) or reached via feature-specific entry points not in the
main moderator menu (the **challenge** cluster via `ChallengeUpsertForm`, **csam/[userId]** via the
image context menu, **scanner-policies** from the scanner-audit area, **contests/bans** and the
**cosmetic-store** sub-pages from their section indexes). Feature-flag gating ≠ skip — those are
shipped features, just toggled.

> **Net:** ~60 pages → migrate **~46**, **skip ~10** (5 hidden + 5 scaffolds), **defer ~4**.

---

## 1. Core moderation

- [ ] **`/moderator/strikes`** — `src/pages/moderator/strikes.tsx` — flag: `strikes`
  - Procedures: `strike.getUserStandings`, `strike.getUserHistory` (queries); `strike.create`, `strike.void` (mutations)
  - Services (`src/server/services/strike.service.ts`): `getUserStandings`, `getStrikeHistoryForMod`, `getStrikesForUser`, `createStrike`, `voidStrike`, `getActiveStrikePoints`, `getStrikeSummary`
  - Schemas: `strike.schema.ts` (`createStrikeSchema`, `voidStrikeSchema`, `getUserStandingsSchema`, `strikeStatusColorScheme`), `user.schema.ts` (`userMetaSchema`)
  - Infra: **Postgres** (heavy raw SQL aggregations) + notification service + email + session refresh; ClickHouse for user scores
  - Notes: optional entity linking, expiration, rate-limit (`shouldRateLimitStrike`), integrates with muting + session invalidation

- [ ] **`/moderator/reports`** — `src/pages/moderator/reports.tsx` — flag: none
  - Procedures: `report.getAll` (query); `report.setStatus`, `report.update` (mutations)
  - Services (`src/server/services/report.service.ts`): `getReports`, `updateReportById`, `bulkSetReportStatus`
  - Schemas: `report.schema.ts` (report-reason schemas, `getReportsSchema`, `setReportStatusSchema`, `updateReportSchema`) + status/reason color constants
  - Infra: **Postgres** + moderator activity/IP tracking
  - Notes: heavy entity polymorphism (Model/Image/Comment/Article/Post/User/Collection/Bounty/CommentV2/ComicProject/Model3D/Chat). Shared `report.service` also powers image appeals — port once.

- [ ] **`/moderator/blocklists`** — `src/pages/moderator/blocklists.tsx` — flag: `blocklists`
  - Procedures: `blocklist.getBlocklist` (query); `blocklist.upsertBlocklist`, `blocklist.removeItems` (mutations)
  - Services (`src/server/services/blocklist.service.ts`): `getBlocklistDTO`, `getBlocklistData`, `upsertBlocklist`, `removeBlocklistItems` (+ utilities `throwOnBlockedLinkDomain`, `throwOnBlockedMessagePattern`, `getBlockedEmailDomains`)
  - Schemas: `blocklist.schema.ts` + `BlocklistType` enum (`server/common/enums.ts`)
  - Infra: **Postgres + Redis** (1-month TTL, fail-open reads, key `SYSTEM.BLOCKLIST:${type}`)
  - Notes: types = LinkDomain / MessagePattern / EmailDomain; case-insensitive; no cross-pod bust (TTL + lazy refresh)

- [ ] **`/moderator/auditor`** — `src/pages/moderator/auditor.tsx` — flag: none
  - Procedures: **none** — purely client-side (`useCheckProfanity` + `~/utils/metadata/audit`)
  - Infra: none. Port the audit utilities client-side; no backend slice.

- [ ] **`/moderator/suspicious-audit-matches`** — `src/pages/moderator/suspicious-audit-matches.tsx` — flag: none
  - Procedures: `userRestriction.getSuspiciousMatches` (query); `userRestriction.clearSuspiciousMatches` (mutation) — **logic inline in `user-restriction.router.ts`**, no service file
  - Infra: **Redis only** (sysRedis list `SYSTEM.SUSPICIOUS_AUDIT_MATCHES`, latest 1000)
  - Notes: extract inline router logic into a service during migration; JSON download is client-side blob

- [ ] **`/moderator/scanner-audit`** (index) — `src/pages/moderator/scanner-audit/index.tsx` — flag: none
  - Procedures: none — server redirect to `/moderator/scanner-audit/text`. Trivial.

- [ ] **`/moderator/scanner-audit/[mode]`** — `src/pages/moderator/scanner-audit/[mode]/index.tsx` — flag: none
  - Procedures: `scannerReview.list`, `scannerReview.reviewStats`, `scannerReview.exportRows` (queries)
  - Services (`src/server/services/scanner-review.service.ts`): `listScans`, `getLabelReviewStats`
  - Schemas: `scanner-review.schema.ts` (`listScansSchema`, `labelReviewStatsSchema`, `queueViewSchema`)
  - Infra: **ClickHouse** (`scanner_label_results` AggregatingMergeTree, partition pruning, GROUP BY dedup) + **Postgres** (`ScannerLabelReview` verdicts)
  - Notes: 3 scanners (xguard_text/xguard_prompt/image_ingestion), 2 queue views (triggered/near-miss), CSV export up to 50k rows

- [ ] **`/moderator/scanner-audit/[mode]/[label]`** — `src/pages/moderator/scanner-audit/[mode]/[label].tsx` — flag: none
  - Procedures: `scannerReview.focusedRun`, `scannerReview.focusedItemContent`, `scannerReview.getWorkflowRaw` (queries); `scannerReview.upsertVerdict` (mutation)
  - Services: `scanner-review.service.ts` (`focusedRun`, `focusedItemContent`, `upsertLabelVerdict`, `deleteLabelVerdict`); `scanner-content.service.ts` (`getWorkflowRaw`, `getScanContents`, `snapshotScanContent`)
  - Schemas: `scanner-review.schema.ts` (`focusedRunSchema`, `focusedItemContentSchema`, `upsertLabelVerdictSchema`) + `ReviewVerdict` enum
  - Infra: **ClickHouse + Postgres (`ScannerLabelReview`, `ScannerContentSnapshot`) + Orchestrator** (live workflow JSON)
  - Notes: per-item review UI, prefetch next 5, keyboard nav, content snapshot survives orchestrator 30-day TTL on first verdict

- [ ] **`/moderator/scanner-policies`** — `src/pages/moderator/scanner-policies/index.tsx` — flag: none
  - Procedures (13): queries `listLabels`, `listCandidates`, `getSystemPrompt`, `listExports`, `getDownloadUrl`; mutations `upsertCandidate`, `setActive`, `deleteCandidate`, `deleteLabel`, `setSystemPrompt`, `cancelRun`, `startRun`, `deleteExport`
  - Services: `scanner-policies.service.ts` (candidate/system-prompt/export CRUD), `scanner-policies-test.service.ts` (`startRun`), `scanner-policies-dataset.service.ts` (`deleteExport`)
  - Schemas: `scanner-policies.schema.ts` (full set)
  - Infra: **Redis** (sysRedis candidates + system prompts, fail-open) + **Postgres** (`DatasetExport`, `ScannerPoliciesRun`) + **S3** (workbooks/signed URLs) + **Signals** (test-run progress)
  - Notes: background test-runner scores datasets and writes results to S3; the most complex page in this cluster

---

## 2. Image / content review

> Most of this cluster funnels through **`image.service.ts`** (~7.9K lines) and **`report.service.ts`** — port those shared services once (see [Shared backend services](#shared-backend-services)).

- [ ] **`/moderator/images`** — `src/pages/moderator/images.tsx` — flags: `csamReports` (CSAM view), `appealReports` (Appeals view)
  - Procedures: `image.getModeratorReviewQueue`, `image.getModeratorReviewQueueCounts`, `image.getModeratorPOITags` (queries); `image.moderate`, `report.bulkUpdateStatus`, `report.resolveAppeal` (mutations)
  - Services: `image.service.ts` (`getImageModerationReviewQueue`, `getImageModerationCounts`, `moderateImages` → `handleBlockImages`/`handleUnblockImages`, `getModeratorPOITags`); `report.service.ts` (`bulkSetReportStatus`, `resolveEntityAppeal`)
  - Schemas: `image.schema.ts` (`imageReviewQueueInputSchema`, `imageModerationSchema`), `report.schema.ts` (`bulkUpdateReportStatusSchema`, `resolveAppealSchema`)
  - Infra: **Postgres + Meilisearch + Redis + S3 (pHash blocks) + Cloudflare (cache purge) + email + comic-project re-queue**
  - Notes: **heaviest page.** `moderateImages` has complex transaction logic (tagging, NSFW level, search-index queue, pHash block); comics re-queue on state change; appeals auto-resolve when appeal images approved.

- [ ] **`/moderator/images/to-ingest`** — `src/pages/moderator/images/to-ingest.tsx` — flag: none
  - Procedures: `image.getAllImagesPendingIngestion` (query)
  - Services: `image.service.ts` → `getImagesPendingIngestion`
  - Infra: **Postgres only.** Simplest of the image pages.

- [ ] **`/moderator/image-tags`** — `src/pages/moderator/image-tags.tsx` — flag: none
  - Procedures: `image.getModeratorReviewQueue` (with `tagReview: true`); `tag.moderateTags` (mutation)
  - Services: `image.service.ts` → `getImageModerationReviewQueue` (reused); `tag.service.ts` → `moderateTags`
  - Schemas: `image.schema.ts` (`imageReviewQueueInputSchema`), `tag.schema.ts` (`moderateTagsSchema`)
  - Infra: **Postgres** + tracking

- [ ] **`/moderator/image-rating-review`** — `src/pages/moderator/image-rating-review.tsx` — flag: none
  - Procedures: `image.getImageRatingRequests` (query); `image.updateImageNsfwLevel` (mutation)
  - Services: `image.service.ts` → `getImageRatingRequests`, `updateImageNsfwLevel`, `updatePendingImageRatings`
  - Schemas: `image.schema.ts` (`imageRatingReviewInput`, `updateImageNsfwLevelSchema`)
  - Infra: **Postgres + Redis (thumbnail cache) + Knights of New Order** queue
  - Notes: `updateImageNsfwLevel` calls raw SQL `update_nsfw_levels_new` and updates KoNO pending votes — shared with downleveled-review

- [ ] **`/moderator/downleveled-review`** — `src/pages/moderator/downleveled-review.tsx` — flag: none
  - Procedures: `image.getDownleveledImages` (query); `image.updateImageNsfwLevel` (mutation, reused)
  - Services: `image.service.ts` → `getDownleveledImages` (+ `updateImageNsfwLevel`)
  - Schemas: `image.schema.ts` (`downleveledReviewInput`, `updateImageNsfwLevelSchema`)
  - Infra: **Postgres + Redis + Knights of New Order**

- [ ] **`/moderator/ingestion-error-review`** — `src/pages/moderator/ingestion-error-review.tsx` — flag: none
  - Procedures: `image.getIngestionErrorImages` (query); `image.resolveIngestionError` (mutation)
  - Services: `image.service.ts` → `getIngestionErrorImages`, `resolveIngestionError`
  - Schemas: `image.schema.ts` (`ingestionErrorReviewInput`, `resolveIngestionErrorInput`)
  - Infra: **Postgres only**

- [ ] **`/moderator/duplicate-hashes`** — `src/pages/moderator/duplicate-hashes.tsx` — flag: none
  - Procedures: **none** — raw SQL in `getServerSideProps`
  - Infra: **Postgres only** (raw `dbRead.$queryRaw`)
  - Notes: SSR-only; port the raw SQL to Kysely in a `load`. Lightweight.

- [ ] **`/moderator/comics-review`** — `src/pages/moderator/comics-review.tsx` — flag: none
  - Procedures: `comics.getModReviewQueue` (**inline query in router**, schema inline); `image.moderate` (mutation, reused)
  - Services: extract inline comics query into a service fn; `moderateImages` (reused from images.tsx)
  - Infra: **Postgres + Meilisearch + Redis + S3 + Cloudflare + email** (via `image.moderate`)
  - Notes: approving via `image.moderate` lifts comic visibility automatically

- [ ] **`/moderator/tags`** — `src/pages/moderator/tags.tsx` — flag: `moderateTags`
  - Procedures: `tag.getManagableTags` (query, **raw SQL in controller**); `tag.addTags`, `tag.disableTags`, `tag.deleteTags` (mutations)
  - Services: `tag.service.ts` (`addTags`, `disableTags`, `deleteTags`) + port the `getManagableTags` raw SQL
  - Schemas: `tag.schema.ts` (`adjustTagsSchema`, `deleteTagsSchema`)
  - Infra: **Postgres only.** Manages `TagsOnTags` relationships (Parent/Replace/Append).

---

## 3. CSAM & content moderation

- [ ] **`/moderator/csam`** (index) — `src/pages/moderator/csam/index.tsx` — flag: `csamReports`
  - Procedures: `csam.getCsamReports`, `csam.getCsamReportsStats` (queries)
  - Services: `csam.service.ts` → `getCsamReportsPaged`, `getCsamReportStats`
  - Schemas: `base.schema.ts` (`paginationSchema`) + user select
  - Infra: **Postgres only**

- [ ] **`/moderator/csam/external`** — `src/pages/moderator/csam/external.tsx` — flag: `csamReports`
  - Procedures: `csam.createExternalReport` (mutation)
  - Services: `csam.service-new.ts` → `createExternalCsamReport`
  - Schemas: `csam.schema.ts` (`createExternalCsamReportSchema`, `externalCsamFileAnnotationsSchema`, `csamContentsDictionary`, `csamCapabilitiesDictionary`)
  - Infra: **Postgres + S3 (secured CSAM bucket) + NCMEC CyberTipline API (`@civitai/cybertipline-tools`) + ClickHouse (user activity) + Orchestrator (consumer strikes)**
  - Notes: highest-sensitivity, most-integrated page. Migrate last.

- [ ] **`/moderator/csam/[userId]`** — `src/pages/moderator/csam/[userId].tsx` — flag: `csamReports`
  - Procedures: `user.getById` (query); UI components submit via `csam.createReport`
  - Services: user lookup by id; `CsamProvider`/`CsamImageSelection`/`CsamDetailsForm` components → full CSAM chain on submit
  - Schemas: `base.schema.ts` (`getByIdSchema`) + `csam.schema.ts`
  - Infra: page itself **Postgres only**, but `csam.createReport` pulls the full CSAM chain (S3/NCMEC/ClickHouse/orchestrator)

- [ ] **`/moderator/articles`** — `src/pages/moderator/articles.tsx` — flag: none (`isModerator` check)
  - Procedures: `moderator.articles.query` (query)
  - Services: `article.service.ts` → `getModeratorArticles`
  - Schemas: `article.schema.ts` (`getModeratorArticlesSchema` extends `infiniteQuerySchema`)
  - Infra: **Postgres only.** `ArticleContextMenu` may issue extra mutations — verify.

- [ ] **`/moderator/article-rating-review`** — `src/pages/moderator/article-rating-review.tsx` — flag: `articleRatingDispute`
  - Procedures: `article.getRatingReviews`, `article.getRatingReviewCounts` (queries)
  - Services: `article.service.ts` → `getArticleRatingReviews`, `getArticleRatingReviewCounts`
  - Schemas: `article.schema.ts` (`getArticleRatingReviewsSchema`) + `ReportStatus` enum
  - Infra: **Postgres only** (secondary image lookup for cover images)

- [ ] **`/moderator/models`** — `src/pages/moderator/models/index.tsx` — flag: none (`requireModerator`)
  - Procedures: `model.getAllPagedSimple` (query); `model.declineReview`, `modelVersion.declineReview` (mutations)
  - Services: `model.service.ts` → `getModels` (+ decline-review handler); `model-version.service.ts` → decline-review handler
  - Schemas: `model.schema.ts` (`getAllModelsSchema`, `declineReviewSchema`)
  - Infra: **Postgres + Meilisearch (index updates) + Redis (caching middleware)**

- [ ] **`/moderator/training-models`** — `src/pages/moderator/training-models.tsx` — flag: `trainingModelsModeration`
  - Procedures: `moderator.models.queryTraining`, `training.getAnnouncement` (queries); `model.toggleCannotPublish`, `training.setAnnouncement` (mutations)
  - Services: `model.service.ts` → `getTrainingModelsForModerators`, `toggleCannotPublish`; Redis KV get/set for `training-announcement`
  - Schemas: `model.schema.ts` (`getTrainingModerationFeedSchema`), `base.schema.ts` (`getByIdSchema`), training-announcement zod object
  - Infra: **Postgres + Meilisearch + Redis (dbKV)**
  - Notes: also downloads training data via `/api/download/training-data/{versionId}` (separate API, not tRPC)

---

## 4. Cosmetic store

> Most of this cluster funnels through **`cosmetic-shop.service.ts`** — port once.

- [ ] **`/moderator/cosmetic-store`** (index) — `cosmetic-store/index.tsx` — flag: none — **navigation only, no backend**
- [ ] **`/moderator/cosmetic-store/badges`** — `cosmetic-store/badges/index.tsx` — flag: none
  - Procedures: `productBadge.getProductsWithBadges`, `productBadge.getBadgeHistory` (queries); `productBadge.upsertProductBadge` (mutation)
  - Services: `product-badge.service.ts` (`getProductsWithBadges`, `getBadgeHistory`, `upsertProductBadge`, `resizeBadgeImage`, `syncActiveBadgeMetadata`)
  - Schemas: `product-badge.schema.ts` (`getProductsWithBadgesInput`, `getBadgeHistoryInput`, `upsertProductBadgeInput`)
  - Infra: **Postgres + Cloudflare Images + Orchestrator (image conversion) + S3**
- [ ] **`/moderator/cosmetic-store/cosmetics`** — `cosmetic-store/cosmetics/index.tsx` — flag: none
  - Procedures: `cosmetic.getPaged`, `cosmeticShop.getPreviewImages`, `userProfile.get` (queries)
  - Services: `cosmetic.service.ts` → `getPaginatedCosmetics`; `cosmetic-shop.service.ts` → `getUserPreviewImagesForCosmetics`
  - Schemas: `cosmetic.schema.ts` (`getPaginatedCosmeticsSchema`), `cosmetic-shop.schema.ts` (`getPreviewImagesInput`)
  - Infra: **Postgres only**
- [ ] **`/moderator/cosmetic-store/products`** — `cosmetic-store/products/index.tsx` — flag: none
  - Procedures: `cosmeticShop.getShopItemsPaged` (query); `cosmeticShop.deleteShopItem` (mutation)
  - Services: `cosmetic-shop.service.ts` (`getPaginatedCosmeticShopItems`, `deleteCosmeticShopItem`)
  - Schemas: `cosmetic-shop.schema.ts` (`getPaginatedCosmeticShopItemInput`), `base.schema.ts` (`getByIdSchema`)
  - Infra: **Postgres only** (delete blocked if purchases exist)
- [ ] **`/moderator/cosmetic-store/products/create`** — `cosmetic-store/products/create.tsx` — flag: none
  - Procedures: `cosmeticShop.upsertShopItem`, `cosmeticShop.upsertCosmetic` (mutations, via `CosmeticShopItemUpsertForm`)
  - Services: `cosmetic-shop.service.ts` (`upsertCosmeticShopItem`, `upsertCosmetic`)
  - Schemas: `cosmetic-shop.schema.ts` (`upsertCosmeticShopItemInput`, `upsertCosmeticInput`)
  - Infra: **Postgres + Image service**
- [ ] **`/moderator/cosmetic-store/products/[id]/edit`** — `cosmetic-store/products/[id]/edit.tsx` — flag: none
  - Procedures: `cosmeticShop.getShopItemById` (query); `upsertShopItem`, `upsertCosmetic` (mutations)
  - Services: `cosmetic-shop.service.ts` (`getShopItemById`, `upsertCosmeticShopItem`, `upsertCosmetic`)
  - Schemas: `base.schema.ts` (`getByIdSchema`), `cosmetic-shop.schema.ts` (upsert inputs)
  - Infra: **Postgres + Image service.** SSG prefetch; dbRead→dbWrite fallback on read miss.
- [ ] **`/moderator/cosmetic-store/sections`** — `cosmetic-store/sections/index.tsx` — flag: none
  - Procedures: `cosmeticShop.getAllSections` (query); `cosmeticShop.updateSectionsOrder`, `cosmeticShop.deleteShopSection` (mutations)
  - Services: `cosmetic-shop.service.ts` (`getShopSections`, `reorderCosmeticShopSections`, `deleteCosmeticShopSection`)
  - Schemas: `cosmetic-shop.schema.ts` (`getAllCosmeticShopSections`, `updateCosmeticShopSectionsOrderInput`), `base.schema.ts` (`getByIdSchema`)
  - Infra: **Postgres only** (reorder via `UNNEST … WITH ORDINALITY`)
- [ ] **`/moderator/cosmetic-store/sections/create`** — `cosmetic-store/sections/create.tsx` — flag: none
  - Procedures: `cosmeticShop.upsertShopSection` (mutation, via `CosmeticShopSectionUpsertForm`)
  - Services: `cosmetic-shop.service.ts` → `upsertCosmeticShopSection`; `image.service.ts` → `createEntityImages`, `enqueueImageIngestion`
  - Schemas: `cosmetic-shop.schema.ts` (`upsertCosmeticShopSectionInput`)
  - Infra: **Postgres + Image service** (section requires an image, enqueued for async ingestion)
- [ ] **`/moderator/cosmetic-store/sections/[id]/edit`** — `cosmetic-store/sections/[id]/edit.tsx` — flag: none
  - Procedures: `cosmeticShop.getSectionById` (query); `cosmeticShop.upsertShopSection` (mutation)
  - Services: `cosmetic-shop.service.ts` (`getSectionById`, `upsertCosmeticShopSection`) + image helpers
  - Schemas: `base.schema.ts` (`getByIdSchema`), `cosmetic-shop.schema.ts` (`upsertCosmeticShopSectionInput`)
  - Infra: **Postgres + Image service.** Section items via delete-all-then-insert on join table.
- [ ] **`/moderator/cosmetics/grant`** — `cosmetics/grant.tsx` — flag: none
  - Procedures: `cosmetic.getPaged`, `user.getAll` (queries); `cosmetic.grantToUsers` (mutation)
  - Services: `cosmetic.service.ts` (`getPaginatedCosmetics`, `grantCosmeticsToUsers`, `grantCosmetics`); `user.controller.ts` user search
  - Schemas: `cosmetic.schema.ts` (`getPaginatedCosmeticsSchema`, `grantCosmeticsToUsersSchema`), `user.schema.ts` (`getAllUsersInput`)
  - Infra: **Postgres only** (idempotent INSERT … ON CONFLICT DO NOTHING)

---

## 5. Challenges & contests

> Most of this cluster funnels through **`challenge.service.ts`** — port once.

- [ ] **`/moderator/challenges`** — `challenges.tsx` — flag: `challengePlatform`
  - Procedures: queries `getModeratorList`, `getSystemConfig`, `getJudges`; mutations `updateSystemConfig`, `endAndPickWinners`, `voidChallenge`, `delete`
  - Services: `challenge.service.ts` (`getModeratorChallenges`, `getChallengeSystemConfig`, `updateChallengeSystemConfig`, `getActiveJudges`, `endChallengeAndPickWinners`, `voidChallenge`, `deleteChallenge`)
  - Schemas: `challenge.schema.ts` (`getModeratorChallengesSchema`, `challengeQuickActionSchema`, `updateChallengeConfigSchema`, `deleteChallengeSchema`)
  - Infra: **Postgres + Redis (config cache) + notifications + buzz transactions** (winner payout)
- [ ] **`/moderator/challenges/create`** — `challenges/create.tsx` — flag: `challengePlatform`
  - Procedures: `getJudges`, `getEvents` (queries); `upsert` (mutation)
  - Services: `challenge.service.ts` (`getActiveJudges`, `getChallengeEvents`, `upsertChallenge`)
  - Schemas: `challenge.schema.ts` (`upsertChallengeSchema`, `getChallengeEventsSchema`)
  - Infra: **Postgres + S3** (cover image; creates a linked Collection in Contest mode)
- [ ] **`/moderator/challenges/[id]/edit`** — `challenges/[id]/edit.tsx` — flag: `challengePlatform`
  - Procedures: `getForEdit`, `getJudges`, `getEvents` (queries); `upsert` (mutation)
  - Services: `challenge.service.ts` (`getChallengeForEdit` + create's services)
  - Schemas: `base.schema.ts` (`getByIdSchema`) + create's schemas
  - Infra: **Postgres + S3**
- [ ] **`/moderator/challenges/events`** — `challenges/events.tsx` — flag: `challengePlatform`
  - Procedures: `getEvents` (query); `upsertEvent`, `deleteEvent` (mutations)
  - Services: `challenge.service.ts` (`getChallengeEvents`, `upsertChallengeEvent`, `deleteChallengeEvent`)
  - Schemas: `challenge.schema.ts` (`getChallengeEventsSchema`, `upsertChallengeEventSchema`, `deleteChallengeSchema`, `challengeEventTitleColors`)
  - Infra: **Postgres only**
- [ ] **`/moderator/challenges/playground`** — `challenges/playground.tsx` — flag: `challengePlatform`
  - Procedures: `getJudges`, `getModeratorList` (queries); `playgroundGenerateContent`, `playgroundReviewImage`, `playgroundPickWinners` (mutations)
  - Services: `challenge.service.ts` (playground methods) + `games/daily-challenge/generative-content.ts` (`generateArticle`, `generateReview`, `generateWinners`) + `daily-challenge.utils.ts` (judging config) + `template-engine.ts`
  - Schemas: `challenge.schema.ts` (`playgroundGenerateContentSchema`, `playgroundReviewImageSchema`, `playgroundPickWinnersSchema`)
  - Infra: **Postgres + AI/LLM (OpenRouter) + Cloudflare Images**
  - Notes: LLM-heavy; depends on template engine + judging config. Migrate after the rest of the challenge cluster.
- [ ] **`/moderator/contests`** (index) — `contests/index.tsx` — flag: `profileCollections`
  - Procedures: `collection.getInfinite` (query, via `useQueryCollections`)
  - Services: `collection.service.ts` → `getAllCollectionsInfinite` (filtered `CollectionMode.Contest`)
  - Schemas: `collection.schema.ts` (`getAllCollectionsInfiniteSchema`), `CollectionSort` enum
  - Infra: **Postgres only**
- [ ] **`/moderator/contests/bans`** — `contests/bans.tsx` — flag: none
  - Procedures: `user.getAll` (query); `user.toggleBan` (mutation)
  - Services: `user.service.ts` (`getUsers`, `toggleContestBan`, `updateUserById`), `auth/session-invalidation.ts` (`refreshSession`)
  - Schemas: `user.schema.ts` (`getAllUsersInput`, `toggleBanUserSchema`)
  - Infra: **Postgres only** (stores `user.meta.contestBanDetails`; session refresh after toggle)
- [ ] **`/moderator/auctions`** — `auctions.tsx` — flag: `auctionsMod`
  - Procedures: `auction.modGetAuctionBases` (query); `auction.modUpdateAuctionBase` (mutation)
  - Services: `auction.service.ts` (`getAuctionBases`, `updateAuctionBase`)
  - Schemas: `auction.schema.ts` (`getAuctionBasesInput`, `updateAuctionBaseInput`)
  - Infra: **Postgres only** (edits affect new auctions only, not running ones)

---

## 6. Rewards, Buzz & cash

- [ ] **`/moderator/rewards`** (index) — `rewards/index.tsx` — flag: none
  - Procedures: `purchasableReward.getModeratorPaged` (query)
  - Services: `purchasable-reward.service.ts` → `getPaginatedPurchasableRewardsModerator`
  - Schemas: `purchasable-reward.schema.ts` (`getPaginatedPurchasableRewardsModeratorSchema`)
  - Infra: **Postgres only**
- [ ] **`/moderator/rewards/create`** — `rewards/create.tsx` — flag: none
  - Procedures: `purchasableReward.upsert` (mutation)
  - Services: `purchasable-reward.service.ts` → `purchasableRewardUpsert`
  - Schemas: `purchasable-reward.schema.ts` (`purchasableRewardUpsertSchema`)
  - Infra: **Postgres + S3 (cover) + Buzz service**
- [ ] **`/moderator/rewards/update/[id]`** — `rewards/update/[id].tsx` — flag: none
  - Procedures: `purchasableReward.getById` (query); `purchasableReward.upsert` (mutation)
  - Services: `purchasable-reward.service.ts` (`getPurchasableReward`, `purchasableRewardUpsert`)
  - Schemas: `base.schema.ts` (`getByIdSchema`), `purchasable-reward.schema.ts` (`purchasableRewardUpsertSchema`)
  - Infra: **Postgres + S3 + Buzz service.** SSG prefetch.
- [ ] **`/moderator/rewards-bonus-events`** — `rewards-bonus-events.tsx` — flag: none
  - Procedures: `rewardsBonusEvent.getPaged` (query); `rewardsBonusEvent.delete` (+ `upsert` via modal) (mutations)
  - Services: `rewards-bonus-event.service.ts` (`getRewardsBonusEventsPaged`, `deleteRewardsBonusEvent`, `getRewardsBonusEventById`, `upsertRewardsBonusEvent`)
  - Schemas: `rewards-bonus-event.schema.ts` (`getRewardsBonusEventsPagedSchema`, `upsertRewardsBonusEventSchema`), `base.schema.ts` (`getByIdSchema`)
  - Infra: **Postgres only** (in-memory cache, 5-min TTL, busted on upsert/delete)
- [ ] **`/moderator/buzz-withdrawal-requests`** — `buzz-withdrawal-requests.tsx` — flags: `creatorsProgram` (router), `buzzWithdrawalTransfer` (transfer/revert buttons)
  - Procedures: `buzzWithdrawalRequest.getPaginated` (query); `buzzWithdrawalRequest.update` (mutation)
  - Services: `buzz-withdrawal-request.service.ts` (`getPaginatedBuzzWithdrawalRequests`, `updateBuzzWithdrawalRequest`)
  - Schemas: `buzz-withdrawal-request.schema.ts` (`getPaginatedBuzzWithdrawalRequestSchema`, `updateBuzzWithdrawalRequestSchema`, `buzzWithdrawalRequestHistoryMetadataSchema`)
  - Infra: **Postgres + Redis + Stripe (transfer reversal) + Tipalti + Axiom + notifications**
  - Notes: **deprecated** system (being replaced by cash-management). Confirm whether to migrate at all before investing.
- [ ] **`/moderator/cash-management`** — `cash-management.tsx` — flag: `cashManagement`
  - Procedures: `moderator.cash.getCashForUser`, `moderator.cash.getWithdrawalHistory`, `user.getCreator` (queries); `moderator.cash.adjustBalance`, `moderator.cash.updateWithdrawal` (mutations)
  - Services: `creator-program.service.ts` (`getCash`, `getWithdrawalHistory`, `modAdjustCashBalance`, `updateCashWithdrawal`)
  - Schemas: `creator-program.schema.ts` (`modCashAdjustmentSchema`, `updateCashWithdrawalSchema`)
  - Infra: **Postgres + Buzz service + ClickHouse (subscription tier) + Axiom**
  - Notes: **new** system replacing buzz-withdrawal-requests; tier caps via ClickHouse; manual Tipalti refund path
- [ ] **`/moderator/code-gifts`** — `code-gifts.tsx` — flag: none
  - Procedures: `redeemableCode.getAllGiftNotices` (query); `redeemableCode.deleteGiftNotice`, `redeemableCode.upsertGiftNotice` (mutations)
  - Services: `redeemableCode.service.ts` (`getAllGiftNotices`, `deleteGiftNotice`, `upsertGiftNotice`)
  - Schemas: `redeemableCode.schema.ts` (`upsertGiftNoticeSchema`, `deleteGiftNoticeSchema`, `giftNoticeSchema`)
  - Infra: **Postgres only** (notices in `KeyValue` table)
- [ ] **`/moderator/paddle/adjustments`** — `paddle/adjustments.tsx` — flag: `paddleAdjustments`
  - Procedures: `paddle.getAdjustmentsInfinite` (infinite query)
  - Services: `paddle.service.ts` → `getAdjustmentsInfinite`
  - Schemas: `paddle.schema.ts` (`getPaddleAdjustmentsSchema` + `AdjustmentAction` enum)
  - Infra: **Paddle API + Postgres** (read-only, cursor pagination)
- [ ] **`/moderator/paddle/customer/[paddleCustomerId]`** — `paddle/customer/[paddleCustomerId].tsx` — flag: none
  - Procedures: **none** — SSR redirect only
  - Services: `user.service.ts` → `getUserByPaddleCustomerId` (in `getServerSideProps`)
  - Infra: **Postgres only.** Looks up user → redirects to profile or Retool (`NEXT_PUBLIC_USER_LOOKUP_URL`). Trivial.

---

## 7. Generation & training

- [ ] **`/moderator/generation`** — `generation.tsx` — flag: none
  - Procedures: `generation.getResources` (query)
  - Services: `generation/generation.service.ts` → `getGenerationResources`
  - Schemas: `generation.schema.ts` (`getGenerationResourcesSchema`)
  - Infra: **Postgres** (+ search index). `toggleUnavailableResource` lives in a child component — verify on migration.
- [ ] **`/moderator/generation-config`** — `generation-config.tsx` — flag: none
  - Procedures: `getEcosystemConfig`, `getGateRules` (queries); `setEcosystemConfig`, `setGateRules` (mutations)
  - Services: `generation/generation.service.ts` (`getGenerationEcosystemConfig`, `setGenerationEcosystemConfig`, `getGateRules`, `setGateRules`)
  - Schemas: `generation.schema.ts` (`generationEcosystemConfigSchema`), `shared/data-graph/generation/gates.ts` (`gateRuleSchema`)
  - Infra: **Redis (sysRedis `SYSTEM.FEATURES`) + Flipt** (`GENERATION_TESTING`)
- [ ] **`/moderator/generation-restrictions`** — `generation-restrictions.tsx` — flag: none
  - Procedures: `userRestriction.getAll` (query); `userRestriction.resolve`, `userRestriction.saveSuspiciousMatches` (mutations) — **logic inline in router**
  - Services: extract inline logic; `user.service.ts` (`updateUserById`), `orchestrator/promptAuditing.ts` (`resetProhibitedRequestCount`, `bustPromptAllowlistCache`), `notification.service.ts` (`createNotification`), `auth/session-invalidation.ts` (`refreshSession`)
  - Schemas: `user-restriction.schema.ts` (`getGenerationRestrictionsSchema`, `resolveRestrictionSchema`, `saveSuspiciousMatchSchema`)
  - Infra: **Postgres + Redis (sysRedis) + Axiom + email + notifications + session mgmt**
- [ ] **`/moderator/review/training-data`** (index) — `review/training-data/index.tsx` — flag: `reviewTrainingData`
  - Procedures: `moderator.modelVersions.query` (infinite, `trainingStatus: 'Paused'`); `modelVersion.recheckTrainingStatus` (mutation)
  - Services: `model-version.service.ts` (`queryModelVersions`, `getVersionById`, `getWorkflowIdFromModelVersion`); `orchestrator/workflows.ts` (`getWorkflow`)
  - Schemas: `model-version.schema.ts` (`queryModelVersionsSchema`), `base.schema.ts` (`getByIdSchema`)
  - Infra: **Postgres + Orchestrator** (needs `ORCHESTRATOR_ACCESS_TOKEN`)
- [ ] **`/moderator/review/training-data/[versionId]`** — `review/training-data/[versionId].tsx` — flag: `reviewTrainingData`
  - Procedures: `modelVersion.getTrainingDetails` (query); `moderator.trainingData.approve`, `moderator.trainingData.deny` (mutations)
  - Services: `model-version.service.ts` (`getVersionById`); `training.controller.ts` (`getJobIdFromVersion`, `moderateTrainingData`); `orchestrator/workflows.ts` (`getWorkflow`)
  - Schemas: `base.schema.ts` (`getByIdSchema`)
  - Infra: **Postgres + Orchestrator (workflow `gateInstructions` mutation) + Axiom + S3** (training-data zip via `/api/download/training-data/{versionId}`)
- [ ] **`/moderator/testing/model3d-seed`** — `testing/model3d-seed.tsx` — flag: none
  - Procedures: **none** — direct HTTP POST to `/api/testing/model3d-seed`
  - Services: recreate the `/api/testing/model3d-seed` handler → `upsertModel3DFromWorkflow`
  - Infra: **S3 + Cloudflare Images** (upload hooks) + the testing API endpoint
  - Notes: testing/debug page; migrate only if model3d seeding is still needed
- [ ] **`/moderator/prompt-audit-test`** — `prompt-audit-test.tsx` — flag: none
  - Procedures: `userRestriction.getTodaysAuditResults`, `userRestriction.getTodaysUserCounts` (queries); `userRestriction.saveSuspiciousMatches` (mutation) — **logic inline in router**
  - Services: extract inline logic; `utils/metadata/audit.ts` (`debugAuditPrompt`)
  - Schemas: `user-restriction.schema.ts` (`saveSuspiciousMatchSchema`)
  - Infra: **ClickHouse (`prohibitedRequests`) + Redis (suspicious matches)**

---

## 8. Misc

- [ ] **`/moderator/announcements`** — `announcements.tsx` — flag: `announcements`
  - Procedures: `announcement.getAnnouncementsPaged` (query); `announcement.deleteAnnouncement` (+ `upsertAnnouncement` via modal) (mutations)
  - Services: `announcement.service.ts` (`getAnnouncementsPaged`, `deleteAnnouncement`, `upsertAnnouncement`)
  - Schemas: `announcement.schema.ts` (`upsertAnnouncementSchema`, `getAnnouncementsPagedSchema`, `getCurrentAnnouncementsSchema`)
  - Infra: **Postgres + Redis** (cache bust)
- [ ] **`/moderator/home-blocks/featured-collections`** — `home-blocks/featured-collections.tsx` — flag: none
  - Procedures: `homeBlock.getFeaturedCollectionsPool` (query); `addCollectionToFeaturedPool`, `removeCollectionFromFeaturedPool`, `acknowledgeFeaturedCollection` (mutations)
  - Services: `home-block.service.ts` (`getFeaturedCollectionsPool`, `add/remove/acknowledge…`, `computeFeaturedCollectionsState`, `getOrCreateFeaturedCollectionsSystemBlock`)
  - Schemas: `home-block.schema.ts` (`toggleFeaturedCollectionInputSchema`, `homeBlockMetaSchema`)
  - Infra: **Postgres + Redis** (`homeBlockCacheBust`); coupled to a background job that computes featured state
- [ ] **`/moderator/service-status`** — `service-status.tsx` — flag: `serviceStatus`
  - Procedures: `generation.getStatusModerator`, `training.getStatusModerator` (queries); `generation.setStatus`, `training.setStatus` (mutations)
  - Services: `generation/generation.service.ts` (`getGenerationStatus`, `setGenerationStatus`); `training.service.ts` (`getTrainingServiceStatus`, `setTrainingServiceStatus`)
  - Schemas: `generation.schema.ts` (`generationStatusModeSchema`), `training.schema.ts` (`trainingServiceStatusSchema`)
  - Infra: **Redis (sysRedis)** only; edge-cache bust (`generation-status`). Fail-open reads, fail-loud writes.
- [ ] **`/moderator/research/rater-sanity`** — `research/rater-sanity.tsx` — flag: none
  - Procedures: `research.raterGetSanityImages` (query); `research.raterUpdateSanityImages` (mutation) — **logic inline in router**
  - Services: extract inline logic (`getSanityIds` helper)
  - Schemas: `research.schema.ts` (`raterUpdateSanityImagesSchema`)
  - Infra: **Postgres (raw SQL on `Image`) + Redis (sysRedis `RATINGS_SANITY_IDS` set)**

### Development scaffolds — DO NOT MIGRATE

These are client-only playgrounds/demos with no backend slice and no production value:

- [ ] ~~`/moderator/aspect-ratio-explorer`~~ — client-only AR calculator (localStorage)
- [ ] ~~`/moderator/link-demo`~~ — Civitai Link demo (`useCivitaiLink`)
- [ ] ~~`/moderator/test`~~ — UI playground (slots, upload, Headless UI)
- [ ] ~~`/moderator/test2`~~ — slot-system reference demo

---

## Shared backend services

Several services back **multiple** pages. Port these once, early, to unblock whole clusters:

| Service | File | Pages it backs |
|---|---|---|
| **Image** | `image.service.ts` (~7.9K lines) | images, to-ingest, image-tags, image-rating-review, downleveled-review, ingestion-error-review, comics-review, cosmetic section image ingestion |
| **Report** | `report.service.ts` | reports, images (appeals + bulk status), comics-review |
| **Cosmetic shop** | `cosmetic-shop.service.ts` | all 9 cosmetic-store pages + cosmetics/grant |
| **Challenge** | `challenge.service.ts` | all 6 challenge pages |
| **User** | `user.service.ts` | contests/bans, cosmetics/grant, generation-restrictions, paddle customer lookup, csam |
| **Creator program** | `creator-program.service.ts` | cash-management (and the new withdrawal path) |
| **Generation** | `generation/generation.service.ts` | generation, generation-config, service-status |
| **Notification / Email / Session-invalidation** | `notification.service.ts`, email templates, `auth/session-invalidation.ts` | strikes, reports, generation-restrictions, contests/bans, buzz-withdrawal |

## Cross-cutting infra to wire (cherry-pick model)

Pull the `@civitai/*` package + env only when a migrated page actually needs it:

- **Redis** (`@civitai/redis`, `REDIS_URL`+`REDIS_SYS_URL`) — blocklists, scanner-policies, generation-config, service-status, suspicious-matches, rater-sanity, prompt-audit-test, announcements, home-blocks, training-models, model caching
- **ClickHouse** (`@civitai/clickhouse`) — scanner-audit, csam/external, cash-management, prompt-audit-test, strikes (user scores)
- **Meilisearch** — models, images (moderate), image-tags, comics
- **S3** — images (pHash), scanner-policies, csam, cosmetic images, rewards, challenges, training-data, model3d-seed
- **Orchestrator client** (`ORCHESTRATOR_ACCESS_TOKEN`) — scanner-audit detail, csam/external, training-data review, product badges
- **External payment/report APIs** — NCMEC CyberTipline (`@civitai/cybertipline-tools`), Paddle, Stripe, Tipalti
- **LLM (OpenRouter)** — challenges/playground
- **Flipt** — generation-config
- **Axiom** (`@civitai/axiom`) — generation-restrictions, buzz-withdrawal, cash-management, training-data
- **Signals** — scanner-policies (test-run progress)

### Recurring porting gotchas

- **Inline router logic** (no service file) needs extraction into a service before porting: `suspicious-audit-matches`, `generation-restrictions`, `prompt-audit-test`, `rater-sanity`, `comics.getModReviewQueue`, `tag.getManagableTags`.
- **Raw SQL** (Prisma `$queryRaw`) must be re-expressed in Kysely: strikes aggregations, duplicate-hashes, tags, image NSFW (`update_nsfw_levels_new`), cosmetic reorder (`UNNEST … WITH ORDINALITY`), grant (`ON CONFLICT`).
- **`/api/download/training-data/{versionId}`** and **`/api/testing/model3d-seed`** are plain API routes, not tRPC — migrate separately.
- **Feature flags** drove gating in the old app; decide the equivalent gating mechanism in the SvelteKit app (the auth `isModerator` guard already covers access; per-feature flags need a port or removal).
