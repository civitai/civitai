# Moderation query port checklist — main app → `@civitai/db-queries`

Scope: the **main app's** (this repo) moderation DB queries that should move into the shared package. The
moderator app's own queries are already ported (19 domains). This list is what remains, split into
**Convergence** (main-app twin of an already-ported domain — replace the local implementation with the shared
one) and **Net-new** (moderation the moderator app doesn't cover — new domains for the package).

> Only `report.service.ts` currently consumes the package (`setReportStatusMany`). Everything below is still a
> main-app-local implementation. Many "convergence" items are **signature-divergent**: the main-app functions
> do multi-step orchestration (index/cache/appeal/notify side-effects) on top of what the package exposes as
> narrow primitives — convergence means _recompose main-app orchestration on the package primitives_, not a 1:1
> swap. Keep pure queries in the package; side-effects stay in the app (same rule used for the moderator port).

---

## Part A — Convergence (twins of already-ported domains)

### reports (`services/report.service.ts`)

- [ ] `getReports` — moderation queue (twin of package `getReports`)
- [ ] `getReportById` / `getReportByIds`
- [ ] `updateReportById` (notes/status → package `updateReportNotes` / `setReportStatus`)
- [ ] `updateImageReportStatusByReason` (`image.service.ts`)
- [ ] `createReport` — not yet in package (Report + per-type join + ImageRatingRequest/tag-vote/article branches)
- [x] `bulkSetReportStatus` — **already delegates** `setReportStatusMany`

### image-review (`services/image.service.ts`)

- [ ] `getImageModerationReviewQueue` (needsReview / tagReview / reportReview CTEs)
- [ ] `getImageModerationCounts` (per-bucket + reported)
- [ ] `getImagesModRules` / `bustImageModRulesCache` (→ `getModerationRuleDefinitions`)
- [ ] `getModeratorPOITags` — POI tag rollup (no exact package twin; near-net-new)

### image-moderation (`services/image.service.ts`, recompose on package primitives)

- [ ] `handleBlockImages` → `setImageBlocked` (+ phash/notify/mod-activity effects stay in app)
- [ ] `handleUnblockImages` → `setImageAccepted` (+ appeal/index/tag effects in app)
- [ ] `moderateImages` (dispatcher)
- [ ] `updateNsfwLevel` → `recomputeImageNsfwLevel`
- [ ] `updateImageNsfwLevel` (6779) → `setImageNsfwLevel`
- [ ] `updateImageAcceptableMinor`, `toggleImageFlag` / `updateImagesFlag`
- [ ] `reportCsamImages` (image branch; report branch → reports)
- [ ] `resolveEntityAppeal` image branch → `setImageAppealStatus`/`-Restored`/`-Rejected`, `getPendingImageAppealAppellants`

### image-moderation-effects (`services/image.service.ts`)

- [ ] phash CH writes `addBlockedImage` / `bulkAddBlockedImages` / `bulkRemoveBlockedImages` (ClickHouse — likely stays app-side)
- [ ] search-index/cache fan-out helpers (`queueImageSearchIndexUpdate`) — effect helpers only

### image-tags (`services/tag.service.ts`, `services/image-review.service.ts`)

- [ ] `getTagsForReview` → `getImageTagReviewQueue` / `getImageTagReviewTags`
- [ ] `moderateTags`, `disableTags` (tag-disable core)
- [ ] `createImageTagsForReview` / `getImagTagsForReviewByImageIds` / `deleteImagTagsForReviewByImageIds`

### tags-on-image (`services/tagsOnImageNew.service.ts`)

- [ ] `insertTagsOnImageNew` / `upsertTagsOnImageNew` / `deleteTagsOnImageNew` (SP writes → `upsert_tag_on_image`)
- [ ] `applyTagRules` / `getTagRules`

### blocklist (`services/blocklist.service.ts`)

- [ ] `upsertBlocklist`, `getBlocklistDTO` / `getBlocklistData`, `removeBlocklistItems`
- [ ] enforcement reads `throwOnBlockedLinkDomain`, `throwOnBlockedMessagePattern`, `getBlockedEmailDomains`, `stripBenignPhrases`
      (note: `utils/moderation-utils.ts` blocklists are **Redis-backed, not DB** — not port targets)

### ingestion (`services/image.service.ts`, `jobs/image-ingestion.ts`)

- [ ] `getImagesPendingIngestion`, `getIngestionErrorImages`, `resolveIngestionError`, `getIngestionResults`
- [ ] `ingestImages` job read/writes (JobQueue-driven)

### scanner (`services/scanner-audit.service.ts`)

- [ ] `recordImageScan` → `scanner_label_results` (→ `upsertScannerLabelVerdict` / `insertScannerContentSnapshot`)

### image-rating-review (`services/image.service.ts`)

- [ ] `getImageRatingRequests` (twin of package `getImageRatingRequests`)

### articles (`services/article.service.ts`, `nsfwLevels.service.ts`)

- [ ] `unpublishArticleById`, `restoreArticleById`, `getModeratorArticles`, `rescanArticle`
- [ ] `recomputeArticleIngestion` / `recomputeArticleIngestionInTx`
- [ ] `updateArticleNsfwLevels`
- [ ] `articleModerationAdapter` (EntityModeration pipeline hooks — see net-new #5)

### article-rating-review (`services/article.service.ts`, `services/article-rating-review.helpers.ts`)

- [ ] `getArticleRatingReviews`, `getArticleRatingReviewCounts`, `resolveArticleRatingReview`
- [ ] `createArticleRatingReview`, `getArticleRatingReviewForOwner`
- [ ] helpers: `computeArticleDerivedNsfwLevel`, `evaluateAutoApproveGate`, `autoResolveArticleRatingReview`, `maybeAutoResolveDisputeAfterScan`

### model3d (`services/model3d.service.ts`, `nsfwLevels.service.ts`)

- [ ] `unpublishModel3D`, `deleteModel3D`, `restoreModel3D`, `setModel3DNsfwLevel`, `toggleModel3DFlag`
- [ ] `updateModel3DNsfwLevels` / `updateModel3DNsfwLevelForThumbnailImage`
- [ ] scope check: `model3d-review.service.ts` (user reviews) / `model3d-report.service.ts` (user reports) — confirm whether the ported "model3d" domain means these

### comics (`routers/comics.router.ts` — inline, needs extraction to service fns first; `nsfwLevels.service.ts`)

- [ ] `setTosViolation`, `setProjectNsfwLevel`, `setChapterNsfwLevel`, `getModReviewQueue`, `moderatorUnpublishChapter`
- [ ] `updateComicChapterNsfwLevels` / `updateComicProjectNsfwLevels` / `updateComicNsfwLevels(ForImage)`

### cosmetics (`services/cosmetic.service.ts`)

- [ ] `grantCosmeticsToUsers` + `grantCosmetics` → package `grantCosmeticsToUsers` / `insertUserCosmeticGrant`
- [ ] `getPaginatedCosmetics` (already ported — replace caller)

### mod-activity (`services/moderator.service.ts`)

- [ ] `trackModActivity` → package `recordModActivity` (callers in report/image services + entity-moderation job)

### rewards (partial) (`services/rewards-bonus-event.service.ts`)

- [x] `getGlobalRewardsBonus` — ported
- [ ] extend: `getActiveRewardsBonusEvent` + `RewardsBonusEvent` CRUD (see net-new #12)

### sidebar-counts (partial) — package has report/appeal/tag-review counts; main-app dashboard counts differ

- [ ] reconcile main-app `getImageModerationCounts` / CSAM `getCsamReportStats` / appeal `getAppealCount` against package counts

---

## Part B — Net-new moderation (no moderator-app equivalent)

### 1. model / modelVersion moderation (`services/model.service.ts`, `model-version.service.ts`)

- [ ] `unpublishModelById`, `unpublishModelVersionById`, `deleteModelById`, `restoreModelById`, `permaDeleteModelById`
- [ ] `toggleLockModel`, `toggleLockComments`, `setModelsCategory`
- [ ] poi/nsfw/minor/sfwOnly + `lockedProperties` via `upsertModel`/`updateModelById`
- [ ] `getTrainingModelsForModerators`
- [ ] `updateModelNsfwLevels` / `updateModelVersionNsfwLevels` (`nsfwLevels.service.ts`)

### 2. model-flag auto-scan queue (`services/model-flag.service.ts`, `model-file-scan.service.ts`)

- [ ] `upsertModelFlag`, `getFlaggedModels`, `resolveFlaggedModel`, `unpublishBlockedModel`

### 3. collection moderation (`services/collection.service.ts`, `nsfwLevels.service.ts`)

- [ ] `updateCollectionItemsStatus`, `setCollectionItemNsfwLevel`, `updateCollectionsNsfwLevels`

### 4. post moderation (`services/post.service.ts`, `nsfwLevels.service.ts`)

- [ ] `deletePost` (mod path), `updatePostNsfwLevel` / `updatePostNsfwLevels`

### 5. entity / text moderation (XGuard / Clavata) (`services/entity-moderation.service.ts`, `jobs/entity-moderation.ts`)

- [ ] `upsertEntityModerationPending`, `recordEntityModerationSuccess`, `recordEntityModerationFailure`, `getEntityModerationWithImageNsfwLevel`
- [ ] job orchestration: `runModQueue`, `runModChat`, `clearAutomatedReports`, `autoMuteIfScamAccount` (+ `ReportAutomated`, JobQueue)
- [ ] note: main app already has a `ModerationAdapter` registry (`moderation-adapters.ts`) — decide if the package standardizes on it

### 6. appeal lifecycle (beyond image status) (`services/report.service.ts`)

- [ ] `createEntityAppeal`, `getRecentAppealsByUserId`, `getAppealCount`, `getAppealDetails`, `resolveEntityAppeal` (non-image branches)

### 7. user moderation / enforcement (`services/user.service.ts`, `jobs/confirm-mutes.ts`)

- [ ] `toggleBan`, `toggleContestBan`, `setUserMuted`, `setUserModerator`, `updateUserById`
- [ ] `softDeleteUser` (CSAM), `deleteUser`, `removeAllContent` (~15-table wipe)
- [ ] `bulkUnpublishModelsForBannedUser`, `setLeaderboardEligibility`
- [ ] `getUsers` (mod lookup w/ banned/muted/deleted status; raw prefix search) — vs package `searchUsers` (verify Meili vs SQL)
- [ ] `confirmMutes` job

### 8. strike / punishment system (`services/strike.service.ts`) — entirely net-new, raw-SQL-heavy

- [ ] reads: `shouldRateLimitStrike`, `getActiveStrikePoints`, `getStrikeSummary`, `getStrikesForUser`, `getStrikeHistoryForMod`, `getStrikesForMod`, `getUserStandings` (dynamic SQL)
- [ ] writes: `evaluateStrikeEscalation` (FOR UPDATE txn), `createStrike`, `voidStrike`, `expireStrikes`, `processTimedUnmutes`

### 9. user restriction (generation enforcement) (`routers/user-restriction.router.ts`, `orchestrator/promptAuditing.ts`)

- [ ] `getAll` (mod queue), `resolve` (uphold/overturn), `submitContext` (PromptAllowlist upsert), `backfillTriggers`
- [ ] `auditPromptServer` (blocked-prompt → auto-mute + UserRestriction), `getCachedPromptAllowlist` / `bustPromptAllowlistCache`

### 10. CSAM / NCMEC (`services/csam.service.ts` + `csam.service-new.ts`) — reconcile the two impls first

- [ ] `createCsamReport`, `createExternalCsamReport`, `uploadExternalCsamEvidence`
- [ ] `getCsamReportsPaged`, `getCsamReportStats`, `getCsamsToReport` / `getCsamsToArchive` / `getCsamsToRemoveContent`
- [ ] `processCsamReport`, `archiveCsamDataForReport`, `getUserIpInfo` (CH+PG), `getImageResources`

### 11. cosmetic revoke / target-assign (`services/cosmetic.service.ts`)

- [ ] `assignCosmeticByTarget` (collection/userIds, dry-run), `unassignCosmetic`, `equipCosmeticToEntity` / `unequipCosmetic`

### 12. RewardsBonusEvent CRUD (`services/rewards-bonus-event.service.ts`)

- [ ] `getActiveRewardsBonusEvent`, `upsertRewardsBonusEvent`, `deleteRewardsBonusEvent`, `getRewardsBonusEventById`, `getRewardsBonusEventsPaged`

### 13. knights "down-leveled" review (`services/image.service.ts`)

- [ ] `getDownleveledImages` (ClickHouse `knights_new_order_downleveled` + PG join) + `addToNewOrderQueue`

### 14. scan-result ingestion pipeline internals (`services/image-scan-result.service.ts`)

- [ ] `resolveScanOutcome`, `auditScanResults`, `markImageScanError`, `blockImageFromRating`, `getAssociatedEntities`, `evaluateImageModRules`, `isExemptFromAiVerification`, `processTags`

---

## Sequencing notes

- **ClickHouse stays out** (per current package charter): phash blocked_images, down-leveled review, `getUserIpInfo` CH reads, prohibited-request counts. Port only the PG parts; flag CH like the moderator port did.
- **Reconcile-before-port**: the two CSAM implementations (`csam.service.ts` vs `-new.ts`); Meili-vs-SQL user search.
- **Extract-before-port**: comic moderation lives inline in `comics.router.ts` — pull into service fns first.
- **Highest net-new value**: strike system, user ban/mute/delete enforcement, CSAM/NCMEC, entity/text moderation — these are large, raw-SQL-heavy, and have no shared equivalent today.
