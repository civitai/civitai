# Tier 1 — Backend Services Checklist

The service layer to recreate for the **[Tier 1](page-migration-checklist.md#tier-1--primary)** page
migration. Each item is a function to port **Prisma → Kysely** into `apps/moderator/src/lib/server/`
(as a load/action-backing service). Grouped by source module in the main app
(`src/server/services/…` unless noted). "Used by" lists the Tier 1 pages that need it.

> **Recording-only scope:** these are the *read/write services* behind the pages. Cross-cutting infra
> clients (Redis, Meilisearch, S3, orchestrator, email) must be wired per the cherry-pick model as the
> services that need them are ported — see [Cross-cutting infra](#cross-cutting-infra-clients).

## Migration cleanup (convention)

When a page's replacement is live in `apps/moderator`, **remove the legacy main-app version in the same
change**. This migration runs on a separate worktree/branch, so deletion is isolated from prod until the
branch ships — and removing the old page is what actually forces moderators onto the new app (a reachable
legacy page just keeps getting used). The trap to avoid: deleting *shared* backend that non-moderator
features still depend on.

**Pages → delete.** Remove the main-app page (`src/pages/moderator/<page>.tsx`) **and** its entry in
`src/components/Moderation/ModerationNav.tsx` as part of the port.

**Moderator-only backend → delete when orphaned.** A tRPC procedure / router / service method used
*exclusively* by removed moderator pages can go too — but **grep for other callers first**
(`grep -rn "<name>" src/`). A live caller means leave it.

**Shared backend → KEEP. Do not delete.** `image.service`, `report.service`, `user.service`,
`model.service`, etc. back non-moderator features as well. Migrating a moderator page **copies** the needed
logic into `apps/moderator`; the original stays. Deleting `report.service.getReports` because the reports
*page* moved would break the main app. When in doubt, it's shared — keep it.

**`TODO(moderator-migration)` marker → only for uncertain orphans.** If a backend symbol *looks*
moderator-only but you can't immediately prove it's unused, tag it (verbatim token) rather than risk it,
and sweep at the end: `grep -rn "TODO(moderator-migration)" src/`.

```ts
// TODO(moderator-migration): appears moderator-only (ported to apps/moderator); verify no callers, then delete.
```

> **Sequencing:** removal lands with the moderator-app replacement, so the branch only loses a page once the
> new app covers it. Don't let the main app deploy with a page removed before the moderator app serves it,
> or moderators hit a gap.

## Do these first (shared backbone)

Ordered by how many pages they unblock — port these before the page-specific ones:

1. **`image.service.ts`** — 7 image pages + comics
2. **`report.service.ts`** — reports + image appeals/bulk-status
3. **`user.service.ts`** (subset) — grant, generation-restrictions, csam
4. **`notification.service.ts`** + **`auth/session-invalidation.ts`** — strikes, generation-restrictions
5. **Orchestrator client** (`orchestrator/workflows.ts` `getWorkflow`) — scanner detail, training-data
6. **`utils/metadata/audit.ts`** (`debugAuditPrompt`) — prompt-audit-test

---

## Porting sequence (waves)

Ordered so **each wave adds at most one or two new infra clients and ships a coherent, releasable set
of pages** — you're never blocked waiting on infra, and the big shared services (`image.service`) are
ported in slices as their infra arrives rather than all at once. Infra carries forward between waves.

### Wave 0 — Foundation ✅ (done)

- **Infra:** Kysely Postgres r/w · auth spoke guard · ClickHouse (+ page-visit tracking)
- The load/action + Kysely patterns are proven; ClickHouse reads are available.

### Wave 1 — Postgres-only pages *(no new infra)*

Establish the service-porting rhythm on the cheapest pages (Postgres, plus already-wired ClickHouse).

- **Pages:** reports · articles · article-rating-review · cosmetics/grant · images/to-ingest · ingestion-error-review · image-tags · scanner-audit/[mode] · tags\*
- **Services:** `report.service` (getReports, updateReportById, bulkSetReportStatus) · `article.service` (3 fns) · `cosmetic.service` (getPaginatedCosmetics, grantCosmeticsToUsers) · `user.service` (getUsers search) · `image.service` slices (getImagesPendingIngestion, getIngestionErrorImages, resolveIngestionError, **getImageModerationReviewQueue**) · `tag.service` (moderateTags, addTags, disableTags, deleteTags, getManagableTags) · `scanner-review.service` (listScans, getLabelReviewStats — ClickHouse+PG)
- \* tags is commented-out in nav — confirm before porting.

### Wave 2 — Notification · Email · Session-invalidation

- **Infra added:** notification service · email · `auth/session-invalidation`
- **Pages:** strikes (full — read uses ClickHouse scores from Wave 0)
- **Services:** `strike.service` (all 7) · `notification.service.createNotification` · `refreshSession`

### Wave 3 — Redis *(+ Flipt)*

- **Infra added:** `@civitai/redis` · Flipt
- **Pages:** blocklists · generation-config · prompt-audit-test · image-rating-review · downleveled-review
- **Services:** `blocklist.service` (all) · `generation.service` (get/set ecosystem config + gate rules) · **user-restriction service** (extract: getTodaysAuditResults, getTodaysUserCounts, saveSuspiciousMatches) + `debugAuditPrompt` · `image.service` (getImageRatingRequests, updateImageNsfwLevel, getDownleveledImages) + **Knights-of-New-Order** (Redis poolCounters) — *raw SQL `update_nsfw_levels_new`; KoNO is the wildcard here*

### Wave 4 — Meilisearch

- **Infra added:** Meilisearch client + index-sync
- **Pages:** models · training-models
- **Services:** `model.service` (getModels, declineReview, getTrainingModelsForModerators, toggleCannotPublish, training-announcement Redis KV) · `model-version.service` (declineReview)

### Wave 5 — S3 + Cloudflare *(the heavy image moderation)*

- **Infra added:** S3 helpers · Cloudflare cache purge
- **Pages:** images · comics-review — **the single biggest effort in Tier 1** (everything converges)
- **Services:** `image.service` (moderateImages + handleBlock/Unblock, getImageModerationCounts, getModeratorPOITags, pHash blocking) · `report.service.resolveEntityAppeal` · **comics review queue** (extract from router) — uses Meili (W4) + Redis (W3) + email (W2)

### Wave 6 — Orchestrator + Axiom

- **Infra added:** orchestrator client (`ORCHESTRATOR_ACCESS_TOKEN`) · `@civitai/axiom`
- **Pages:** scanner-audit/[mode]/[label] · review/training-data (index + [versionId]) · generation-restrictions
- **Services:** `scanner-content.service` (3 fns) · `scanner-review.service` (focusedRun, focusedItemContent, upsert/deleteLabelVerdict) · `model-version.service` (queryModelVersions, getVersionById, getWorkflowIdFromModelVersion) · training moderation (moderateTrainingData, getJobIdFromVersion) · `orchestrator/workflows.getWorkflow` · `orchestrator/promptAuditing` (resetProhibitedRequestCount, bustPromptAllowlistCache) · **user-restriction** (getGenerationRestrictions, resolveRestriction) · API route `/api/download/training-data/{versionId}`

### Wave 7 — Specialized *(NCMEC · Signals)*

- **Infra added:** NCMEC CyberTipline (`@civitai/cybertipline-tools`) · Signals · S3 background runner
- **Pages:** csam/index\*\* · csam/[userId] · csam/external · scanner-policies
- **Services:** `csam.service` (getCsamReportsPaged, getCsamReportStats) · `csam.service-new.createExternalCsamReport` + createReport chain · user lookup (getUserById) · `scanner-policies.service` (+ `-test`, `-dataset`) with Signals
- \*\* csam/index is Postgres-only and could be pulled forward to Wave 1; kept here to migrate the CSAM cluster together.

**Critical-path note:** Waves 1–4 are mostly independent and could be parallelized across people. Wave 5
(image moderation) and Wave 6 (orchestrator) are the heavy, sequential ones — they gate the largest pages.

---

## Core moderation

### `strike.service.ts`  ·  used by: strikes
- [ ] `getUserStandings` — paginated standings (raw SQL aggregation over `UserStrike`) — *ClickHouse for user scores*
- [ ] `getStrikeHistoryForMod`
- [ ] `getStrikesForUser` (util)
- [ ] `createStrike` — *notification + email + session refresh; rate-limit `shouldRateLimitStrike`*
- [ ] `voidStrike`
- [ ] `getActiveStrikePoints` (util)
- [ ] `getStrikeSummary` (util)

### `report.service.ts`  ·  used by: reports, images  *(SHARED)*
- [ ] `getReports` — entity polymorphism (Model/Image/Comment/Article/Post/User/Collection/Bounty/CommentV2/ComicProject/Model3D/Chat)
- [ ] `updateReportById`
- [ ] `bulkSetReportStatus` — *moderator activity/IP tracking*
- [ ] `resolveEntityAppeal` — *notifications + Meilisearch + comic re-queue* (images page)

### `blocklist.service.ts`  ·  used by: blocklists  ·  *Postgres + Redis (1-mo TTL, fail-open)*
- [ ] `getBlocklistDTO`
- [ ] `getBlocklistData` (util)
- [ ] `upsertBlocklist`
- [ ] `removeBlocklistItems`
- [ ] `throwOnBlockedLinkDomain` (util)
- [ ] `throwOnBlockedMessagePattern` (util)
- [ ] `getBlockedEmailDomains` (util)

### `scanner-review.service.ts`  ·  used by: scanner-audit/[mode], scanner-audit/[mode]/[label]  ·  *ClickHouse + Postgres + Orchestrator*
- [ ] `listScans`
- [ ] `getLabelReviewStats`
- [ ] `focusedRun`
- [ ] `focusedItemContent`
- [ ] `upsertLabelVerdict`
- [ ] `deleteLabelVerdict`

### `scanner-content.service.ts`  ·  used by: scanner-audit/[mode]/[label]  ·  *Orchestrator + Postgres snapshot*
- [ ] `getWorkflowRaw`
- [ ] `getScanContents`
- [ ] `snapshotScanContent`

### `scanner-policies.service.ts` (+ `-test`, `-dataset`)  ·  used by: scanner-policies  ·  *Redis + Postgres + S3 + Signals*
- [ ] `listLabels`
- [ ] `listCandidates`
- [ ] `upsertCandidate`
- [ ] `setCandidateActive`
- [ ] `deleteCandidate`
- [ ] `deleteLabel`
- [ ] `getSystemPrompt`
- [ ] `setSystemPrompt`
- [ ] `listExports`
- [ ] `getExportById` — *S3 signed URL*
- [ ] `markRunCancelled`
- [ ] `startRun` (`scanner-policies-test.service.ts`) — *S3 + background test runner + Signals*
- [ ] `deleteExport` (`scanner-policies-dataset.service.ts`) — *S3*

---

## Image / content review

### `image.service.ts`  ·  used by: images, to-ingest, image-tags, image-rating-review, downleveled-review, ingestion-error-review, comics-review  *(SHARED — the big one)*
- [ ] `getImageModerationReviewQueue` — drives images + image-tags (`tagReview`) + comics
- [ ] `getImageModerationCounts`
- [ ] `moderateImages` (+ `handleBlockImages`, `handleUnblockImages`) — *Meilisearch + Redis + S3 pHash + Cloudflare purge + email + comic re-queue*
- [ ] `getModeratorPOITags`
- [ ] `getImagesPendingIngestion`
- [ ] `getImageRatingRequests` — *Knights of New Order*
- [ ] `updateImageNsfwLevel` (+ `updatePendingImageRatings`) — *raw SQL `update_nsfw_levels_new`; Redis thumbnail cache; KoNO* (rating-review + downleveled)
- [ ] `getDownleveledImages`
- [ ] `getIngestionErrorImages`
- [ ] `resolveIngestionError`
- [ ] `createEntityImages` + `enqueueImageIngestion` — *(only if a Tier 1 page needs image upload; primarily Tier 2 cosmetics — verify)*

### `tag.service.ts`  ·  used by: image-tags, tags
- [ ] `moderateTags` (image-tags)
- [ ] `addTags` (tags)
- [ ] `disableTags` (tags)
- [ ] `deleteTags` (tags)
- [ ] `getManagableTags` — **raw SQL, currently in `tag.controller.ts`** — extract into a service

### Comics review queue  ·  used by: comics-review  ·  **NEW service (extract)**
- [ ] `getComicModReviewQueue` — **inline in `comics.router.ts` today** — extract into a service fn (JOIN `ComicPanel` → `Image` with `needsReview`/`tosViolation`/`ingestion` filters)
- [ ] (moderation reuses `image.service.moderateImages`)

---

## CSAM & content

### `csam.service.ts` / `csam.service-new.ts`  ·  used by: csam/index, csam/external, csam/[userId]
- [ ] `getCsamReportsPaged` (`csam.service.ts`)
- [ ] `getCsamReportStats` (`csam.service.ts`)
- [ ] `createExternalCsamReport` (`csam.service-new.ts`) — *S3 (CSAM bucket) + NCMEC CyberTipline + ClickHouse + Orchestrator* — highest-sensitivity; do last
- [ ] `createReport` chain (the `csam/[userId]` submit path) — full CSAM chain
- [ ] user-lookup-by-id (see `user.service.ts` below) for `csam/[userId]`

### `article.service.ts`  ·  used by: articles, article-rating-review  ·  *Postgres only*
- [ ] `getModeratorArticles`
- [ ] `getArticleRatingReviews` (secondary cover-image lookup)
- [ ] `getArticleRatingReviewCounts`

### `model.service.ts`  ·  used by: models, training-models  ·  *Postgres + Meilisearch + Redis*
- [ ] `getModels` (`getAllPagedSimple` path)
- [ ] `declineReview` (model)
- [ ] `getTrainingModelsForModerators`
- [ ] `toggleCannotPublish`
- [ ] training-announcement Redis KV get/set (`training-announcement` key)

### `model-version.service.ts`  ·  used by: models, review/training-data (both)  ·  *Postgres + Orchestrator*
- [ ] `declineReview` (model-version)
- [ ] `queryModelVersions` (moderator feed, `trainingStatus: 'Paused'`)
- [ ] `getVersionById`
- [ ] `getWorkflowIdFromModelVersion`

---

## Generation & training

### `generation/generation.service.ts`  ·  used by: generation, generation-config
- [ ] `getGenerationResources` — *Postgres + search index*
- [ ] `getGenerationEcosystemConfig` — *Redis sysRedis + Flipt (`GENERATION_TESTING`)*
- [ ] `setGenerationEcosystemConfig`
- [ ] `getGateRules`
- [ ] `setGateRules`

### User-restriction service  ·  used by: generation-restrictions, prompt-audit-test  ·  **NEW service (extract)**
> Logic is **inline in `user-restriction.router.ts`** today — extract into a service.
- [ ] `getGenerationRestrictions` (`getAll`) — *Postgres*
- [ ] `resolveRestriction` — *Axiom + email + notifications + session mgmt* (calls `updateUserById`, `refreshSession`, `createNotification`, `resetProhibitedRequestCount`, `bustPromptAllowlistCache`)
- [ ] `saveSuspiciousMatches` — *Redis sysRedis*
- [ ] `getTodaysAuditResults` — *ClickHouse `prohibitedRequests`* (uses `debugAuditPrompt`)
- [ ] `getTodaysUserCounts` — *ClickHouse*

### Training moderation  ·  used by: review/training-data/[versionId]
- [ ] `moderateTrainingData` (`training.controller.ts`) — *Orchestrator `gateInstructions` + Axiom* — extract into a service
- [ ] `getJobIdFromVersion` (`training.controller.ts`)

---

## Cosmetics (grant only)

### `cosmetic.service.ts`  ·  used by: cosmetics/grant  ·  *Postgres*
- [ ] `getPaginatedCosmetics`
- [ ] `grantCosmeticsToUsers` (+ `grantCosmetics` helper) — raw SQL INSERT … ON CONFLICT DO NOTHING

---

## Shared / cross-cutting services

### `user.service.ts` (subset)  ·  used by: cosmetics/grant, generation-restrictions, csam  *(SHARED)*
- [ ] `getUsers` / user search (the `user.getAll` path, in `user.controller.ts`) — grant page
- [ ] `getUserById` — csam/[userId]
- [ ] `updateUserById` — generation-restrictions resolve

### `notification.service.ts`  *(SHARED)*
- [ ] `createNotification` — strikes, generation-restrictions

### `auth/session-invalidation.ts`  *(SHARED)*
- [ ] `refreshSession` — strikes, generation-restrictions

### Orchestrator  *(SHARED)*  ·  *needs `ORCHESTRATOR_ACCESS_TOKEN`*
- [ ] `getWorkflow` (`orchestrator/workflows.ts`) — scanner detail, training-data
- [ ] `resetProhibitedRequestCount` + `bustPromptAllowlistCache` (`orchestrator/promptAuditing.ts`) — generation-restrictions

### `utils/metadata/audit.ts`  *(SHARED)*
- [ ] `debugAuditPrompt` — prompt-audit-test (and the client-only auditor page)

---

## Non-tRPC API handlers (port separately)

These are plain API routes in the main app, not tRPC — recreate as SvelteKit endpoints/handlers:
- [ ] `/api/download/training-data/{versionId}` — used by both training-data pages (S3 zip)
- [ ] `/api/testing/model3d-seed` → `upsertModel3DFromWorkflow` — only if model3d seeding is still needed (else drop)

---

## No backend needed

- **auditor** — client-only (`debugAuditPrompt`/profanity utils run client-side)
- **scanner-audit/index** — pure redirect to `/scanner-audit/text`

---

## Cross-cutting infra clients

Wire these into the app (cherry-pick) as the services above are ported:

| Client | Needed by (Tier 1) | Status |
|---|---|---|
| **ClickHouse** (`@civitai/clickhouse`) | strikes, scanner-audit, csam/external, prompt-audit-test | ✅ wired (page-visit tracking) |
| **Redis** (`@civitai/redis`) | blocklists, scanner-policies, generation-config, training-models, model caching, user-restriction | ❌ not wired |
| **Meilisearch** | images, image-tags, comics, models | ❌ not wired |
| **S3** | images (pHash), scanner-policies, csam, training-data | ❌ not wired |
| **Orchestrator** (`ORCHESTRATOR_ACCESS_TOKEN`) | scanner detail, csam/external, training-data | ❌ not wired |
| **NCMEC** (`@civitai/cybertipline-tools`) | csam/external | ❌ not wired |
| **Email + Notification + session-invalidation** | strikes, generation-restrictions | ❌ not wired |
| **Axiom** (`@civitai/axiom`) | generation-restrictions, training-data | ❌ not wired |
| **Flipt** | generation-config | ❌ not wired |
| **Signals** | scanner-policies (test-run progress) | ❌ not wired |

## Porting gotchas (Tier 1)

- **Extract inline router logic into services first:** comics review queue, user-restriction (generation-restrictions + prompt-audit-test), training moderation, `getManagableTags`.
- **Raw SQL → Kysely:** strikes aggregations, `getManagableTags`, `update_nsfw_levels_new` (image NSFW), grant `ON CONFLICT`.
- **Reused services** (port once): `image.service` queue + `moderateImages`, `report.service.bulkSetReportStatus`, `updateImageNsfwLevel`, `user.service` helpers, `getWorkflow`.
