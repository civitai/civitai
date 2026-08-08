# Migrated moderator pages — full-fidelity + de-duplication plan

_Drafted 2026-07-10. Scope: the moderator **pages we are migrating**. Not a general "move all inline
moderator actions out of the main app" effort._

## Two rules

1. **A migrated page's mutations must do everything the legacy did.** No deferring infra side effects (Redis
   busts, pHash blocklist, notifications, email, buzz, ClickHouse tracking) to "a later wave" — that's how we
   silently drop legacy behavior. Deliverable 1 is the list of what's currently missing.
2. **Only when a page migration duplicates logic the main app still needs elsewhere** do we lift that logic
   into a spoke `/api/mod/[action]` endpoint and have the main app call it. If a mutation is used only by the
   migrated page, the spoke just owns it (already the case) — no endpoint. Deliverable 2 is that (short) list.

The endpoint is a **de-duplication tool**, not a goal. It only applies to mutations that are (a) moderator-only
and (b) still invoked by a live main-app surface after the page migrates.

---

## Deliverable 1 — Side effects the migrated pages currently miss

Complete these to make each already-merged slice a faithful replacement. Each box is a legacy side effect the
spoke omits; infra tag = what must be wired. (Audited spoke-vs-legacy across every migrated mutation.
**Verified already complete — nothing to do:** image-tag moderation, blocklists, cosmetics grant, scanner
verdicts.)

### Image accept — `acceptImage`  ·  (images minor/poi/…, comics-review approve) — ✅ complete
- [x] Remove pHash from blocklist (`bulkRemoveBlockedImages`) — **ClickHouse `blocked_images`** — else re-uploads keep auto-blocking
- [x] Bust post/gallery caches (`bustCachesForPosts` tag-bust) — **Redis**
- [x] Refresh thumbnail cache (in `recompute`, mirroring `updateNsfwLevel`) — **Redis**
- [x] Re-queue parent comic(s) (`queueComicsForPanelImages`, all comics containing the image) — **comic search-index**
- [x] Auto-resolve appeal when `needsReview==='appeal'` (`resolveEntityAppeal(Approved)`) — **appeal cascade**

### Image block — `blockImage`  ·  (images, comics-review block) — ✅ complete
- [x] Add pHash to blocklist (`bulkAddBlockedImages`) — **ClickHouse `blocked_images`** — the handler hardcodes `include: ['phash-block']`, so always on
- [x] Invalidate image-exists cache (`invalidateManyImageExistence`) — **Redis (sysRedis)**
- [x] Bust post/gallery caches (`bustCachesForPosts` tag-bust) — **Redis**
- [x] Re-queue parent comic(s) — **comic search-index**
- [x] `DeleteTOS` analytics (`ctx.track.images` in `moderateImageHandler`, block only) — **ClickHouse** — ported the 5 lookups + tos/nsfw mappings; inserts into the CH `images` table with actor ip/userAgent threaded from the form action
- [x] Notify uploader (`createNotification` `tos-violation`; handler hardcodes `include: ['user-notification']`) — **notifications** — wired via `@civitai/notifications` (the existing HTTP client to `apps/notifications`; needs `NOTIFICATIONS_ENDPOINT`/`_TOKEN` in the deployed spoke env, best-effort so a missing endpoint no-ops)

**Showcase gallery (`imagesForModelVersionsCache`):** the spoke **busts** the per-version packed key
(`bustCachedObject(IMAGES_FOR_MODEL_VERSION, versionIds)`), same as it busts every other cache. The main
app *refreshes* (re-populates from primary) only to dodge a replication-lag re-cache window, but lag
routing is off by default and it busts every other gallery cache anyway — so a bust is the consistent,
faithful choice (no callback, no query/packed-write duplication).

### Image appeal resolve — `resolveImageAppeal`  ·  (images appeals) — ✅ complete
- [x] Re-queue parent comic + bust post caches (both directions) + thumbnail bust (approve, via `recompute`) — **comic index / Redis**
- [x] Refund appeal fee on approve (`refundAppealFee`, `appeal-` prefix → multi-txn) — **buzz** (`@civitai/buzz` client wired)
- [x] Notify appellant (`entity-appeal-resolved`) — **notifications** (`@civitai/notifications`)
- [x] Appeal-resolution email (`appealResolutionEmail`, spoke template) — **email** (`@civitai/email` client wired)
- [x] Shared `runAppealCascade` also runs from `acceptImage`'s appeal-queue auto-approve (legacy `handleUnblockImages` did too)
- [ ] Persist `internalNotes` — **DB** (minor; spoke `resolveImageAppeal` takes no `internalNotes` yet)

### Image nsfwLevel set — `updateImageNsfwLevel`  ·  (image-rating-review, downleveled-review)
- [ ] Stamp `metadata.nsfwLevelReason` — **DB**
- [ ] Refresh `imageMetadataCache` — **Redis**
- [ ] Re-derive Model3D nsfwLevel for thumbnail images — **DB rollup**
- [ ] Finalize Knights-of-New-Order votes (`updatePendingImageRatings`) — **ClickHouse + KoNO**
- [ ] Remove image from new-order pools (`pool.reset`) — **Redis (new-order)**

### Ingestion error resolve — `resolveIngestionError`  ·  (ingestion-error-review) — ✅ complete
- [x] Bust `imageMetadataCache` + `tagIdsForImagesCache` — **Redis** (`bustCachedObject`). Main-app procedure/service already removed (only a `NOTE(moderator-migration)` marker remains) — no cutover needed.

### Reports set-status — `setReportStatus`  ·  (reports) — ✅ complete
- [x] Reward reporter(s) on Actioned (`reportAcceptedReward`, incl. `alsoReportedBy`, with `ip`) — **ClickHouse** (`buzzEvents` pending row), in `lib/server/rewards.ts`.
  - `reportAcceptedReward` is a **processable** reward (has `caps`, not `onDemand`): the main app's inline `apply` only inserts a `pending` `buzzEvents` row; the actual cap-enforcement + buzz grant happens in the main-app `process-rewards` cron (every minute), which reads pending rows **regardless of which app wrote them**. So the spoke rewards reporters simply by writing that pending row — no rewards engine / buzz-grant on the spoke.
  - `rewardReportReporters` builds the `buzzEvents` row inline (field set + `pending` status + ip/transactionDetails normalization mirror `base.reward.ts`; `awardAmount=50` mirrors `reportAccepted.reward.ts`) and inserts via `getClickhouse()`. Kept in sync by doc-comments — it's a faithful copy of the main-app shapes, not a shared package (a spoke-only recorder needs no cross-app contract; the row shape is enforced by the CH table DDL both apps write to).
  - Multiplier is resolved spoke-side: base supporter multiplier read from the **shared** `MULTIPLIERS_FOR_USER` cache the main app populates (cold miss → 1), × the active global bonus event (`RewardsBonusEvent`, `multiplier/10` clamped to `[1, 5]`) — a faithful port of `getMultipliersForUser`.
  - Wired into `setReportStatus` via `UPDATE … RETURNING userId, alsoReportedBy` so only a real transition to Actioned rewards (re-actioning can't double-reward). Page action threads the moderator `ip` via `getClientAddress()`.
- **No cutover** (`bulkSetReportStatus` stays): its 3 callers — `pages/api/mod/action-report.ts` (retool webhook), `csam.controller.ts` (CSAM flow), `image.service.ts` (image-TOS flow) — are internal/external **server** flows, **not** the migrated reports page (which uses the spoke's own `setReportStatus`). Exactly like `handleBlockImages` + the KoNO game, these keep the main-app primitive; repointing internal flows to HTTP-call the spoke isn't warranted. `bulkSetReportStatus` retires when *those* slices migrate. See Deliverable 2 below.

### Article restore — `restoreArticle`  ·  (articles) — ✅ complete
- [x] Recompute ingestion state (`recomputeArticleIngestionInTx` — image/text scan-state → Blocked/Error/Scanned/Pending) — **DB**
- [x] Refresh `userArticleCountCache` (`bustCachedObject`) — **Redis**
- [n/a] Owner ingestion notifications — the legacy's `article-published`/`article-images-blocked` are gated on `status='Processing'`; restore sets `status='Published'` first, so they don't fire on the restore path (they belong to the scan pipeline). Replication-lag guards omitted (lag routing off by default).

### Article delete — `deleteArticle`  ·  (articles) — ⛔ blocked on `@civitai/storage`
- [ ] Delete cover image + orphaned content images (`deleteImageById`) — **DB + S3 + CDN** — needs the S3/storage client

### Article rating resolve — `resolveArticleRatingReview`  ·  (article-rating-review) — ✅ complete
- [x] Notify owner (`article-rating-review-approved` when the mod grants the suggested level / `-rejected` when a different level is applied; level labels + modComment) — **notifications** (`@civitai/notifications`)

---

## Deliverable 2 — De-duplication endpoints (`/api/mod/[action]`)

Only the migrated-page mutations that are **moderator-only AND still called by a live main-app surface**. These
get lifted into a spoke endpoint (the single implementation), and the main-app callers are repointed + the
main-app procedure deleted. Everything else stays spoke-owned (no endpoint).

### ✅ DONE — Endpoint: `image-moderate`
- Spoke: `mod-actions/registry.ts` (`image-moderate` → loops `blockImage`/`acceptImage`) + `routes/api/mod/[action]/+server.ts`
  (shared-`WEBHOOK_TOKEN` auth; `/api/mod/*` bypasses the session guard in `hooks.server.ts`).
- Main app: `moderateImageHandler` now delegates via `moderatorApp.imageModerate(…)` (the `@civitai/moderation`
  client singleton in `services/moderator-app.service.ts`), threading the moderator `userId`/`ip`/`userAgent`.
  The thin `image.moderate` procedure stays (client callers
  `NeedsReviewBadge`/`UnblockImage` can't hold the token); `moderateImages` + the handler's DeleteTOS block are **deleted**.
- **Not fully deleted:** `handleBlockImages`/`handleUnblockImages` remain — the KoNO game (`new-order.service.ts`) and the
  external `api/mod/{remove,restore}-images` endpoints still call them directly (separate slices). Their `include`-branches are now dead.
- **Out of this slice:** `image.setTosViolation` (the inline "Report TOS Violation" context-menu action, `useReportTosViolation`)
  is a distinct workflow with its own handler + no spoke equivalent — a separate future slice, left in the main app.

### ❎ NOT AN ENDPOINT — `report-set-status` (no cutover)
- Re-scoped after inspecting the callers. `bulkSetReportStatus`'s only callers are internal/external **server**
  flows — `pages/api/mod/action-report.ts` (retool webhook), `csam.controller.ts` (CSAM flow),
  `image.service.ts` (image-TOS flow) — **not** the migrated reports page. The reports page uses the spoke's
  own `setReportStatus` directly, so there is no duplicated *page* mutation to lift into an endpoint.
- This is the same call as `handleBlockImages` + the KoNO game: an internal main-app primitive with non-page
  consumers stays in the main app; repointing an internal server flow to HTTP-call the spoke isn't warranted.
- The migrated page's only real gap — the reporter reward — is done in Deliverable 1 (`lib/server/rewards.ts`).
  `bulkSetReportStatus` retires when the CSAM / image-TOS / retool-report slices themselves migrate.

### ⚠️ Not clean endpoints — decide explicitly
- **`updateImageNsfwLevel`** — still used by `SetBrowsingLevelModal`, which is **owner-or-mod** (dual-gated).
  A mod-only endpoint would break the owner path. Options: leave duplicated (main keeps the owner path, spoke
  keeps the mod path), or extract a shared pure-core package. Recommend: **leave duplicated for now**; revisit
  with a shared package if it drifts. (The mod-only API routes `retool/image.ts` + `set-image-nsfw-level.ts`
  *could* repoint to a spoke endpoint later, but the modal can't.)
- **`upsertTagsOnImageNew`** — used by the scan webhook + `apply-voted-tags` job. It's a low-level tagging
  **utility**, not a moderator action; the pipeline can't call a mod endpoint. Not an endpoint candidate.
  The spoke's copy is a faithful port; accept the duplication or extract a shared package later.

### No endpoint (page-only — spoke already owns, main-app version orphaned)
`resolveIngestionError`, `resolveArticleRatingReview`, article `restore`/`delete`, blocklist, cosmetics grant,
scanner verdict. For article restore/delete: **verify the main-app `restoreArticleById`/`deleteArticleById`
are now orphaned and remove them** (no live callers found) — a cleanup, not an endpoint.

---

## Architecture — the `/api/mod` surface  _(image-moderate shipped; future mod-only page mutations follow the same shape)_

```
packages/civitai-moderation/                 # SHARED contract + client (dep of both apps)
  src/schema.ts        # action input zod schemas + MOD_ACTION names (the wire contract)
  src/client.ts        # createModeratorClient({endpoint, token}) → typed methods (imageModerate, …); no retry
apps/moderator/src/lib/server/mod-actions/
  registry.ts          # action -> { schema (from @civitai/moderation), handler }
apps/moderator/src/routes/api/mod/[action]/+server.ts   # cross-app entry (main app -> spoke)
src/server/services/moderator-app.service.ts # main app's configured `moderatorApp` client singleton
```

- **`@civitai/moderation`** is the single source of truth for the cross-app contract: the spoke registry
  validates against its schemas and the main-app client is typed against them, so producer and consumer
  can't drift (same pattern as `@civitai/notifications`). Add an action = schema + `MOD_ACTION` name +
  client method here, then a handler in the spoke registry.
- **Handlers** own the complete operation against the spoke's wired infra (call the same services the
  moderator pages use). **Registry** is the spoke-side catalog.
- **`/api/mod/[action]`** — POST, shared-`WEBHOOK_TOKEN` auth (mirror of `syncSearchIndex`, reverse
  direction), `Object.hasOwn` action lookup, validate body against its `schema`, run the handler, return
  JSON. `userId` is asserted by the trusted caller. `/api/mod/*` bypasses the session guard in
  `hooks.server.ts` (self-authenticates via token).
- **Main app** calls via the `moderatorApp` client singleton (`moderatorApp.imageModerate(…)`); the thin
  `image.moderate` tRPC procedure stays as the proxy for client components that can't hold the token.
- **Spoke form actions** keep calling the services directly (no self-HTTP) — same code the registry runs.

Only actions in Deliverable 2 go through the registry/endpoint. Page-only mutations stay as direct spoke
service calls.

## Infra to wire (for the 2 endpoints + Deliverable 1 fidelity)

Scoped to what the migrated actions actually need:

| Infra | Needed by | Status |
|---|---|---|
| **Redis** busts (image/thumbnail/metadata/tagIds/post/existence/userArticleCount caches) | image accept/block/nsfw, ingestion, article restore | partially wired (blocklist) |
| **ClickHouse writes** (`blocked_images` pHash, `DeleteTOS`, KoNO rating buffer) | image block/accept/nsfw, report reward | reads only |
| **Notifications** | image block/appeal, article restore/rating | ❌ |
| **Email** | appeal resolve | ❌ |
| **Buzz** | report reward, appeal refund | ❌ |
| **S3 + CDN** | article delete | ❌ |
| **Knights-of-New-Order** (Redis pools) | image nsfw finalize | ❌ |
| **Meilisearch** | all — stays the `syncSearchIndex` callback (no client pull-in) | ✅ |

## Sequencing

1. **Endpoint spine** — `mod-actions/registry.ts`, `dispatch()`, `/api/mod/[action]/+server.ts`, token auth,
   gate exemption.
2. **Wire the infra clients** the image/report actions need, cherry-picked (Redis busts, ClickHouse writers,
   notifications, buzz, email, S3/CDN).
3. **Complete `image-moderate`** to full fidelity (Deliverable 1 Image sections), register it, retrofit the
   migrated pages (/images, comics-review, appeals) to `dispatch('image-moderate', …)`.
4. **Repoint `image.moderate` + `image.setTosViolation`** callers (`NeedsReviewBadge`, `UnblockImage`,
   `useReportTosViolation`) to `/api/mod/image-moderate`; delete the main-app procedures + `moderateImages`.
5. **Reporter reward (no endpoint)**: complete the spoke `setReportStatus` reporter-reward by writing the
   pending `buzzEvents` row inline (`lib/server/rewards.ts`). `bulkSetReportStatus` stays for its internal
   callers (`action-report`, `csam`, image-TOS) — not a page mutation, so no cutover (see Deliverable 2). ✅ done.
6. **Finish the page-only fidelity gaps** (Deliverable 1: nsfwLevel, ingestion, article restore/delete/rating)
   as direct spoke service work — no endpoint. Remove orphaned main-app article restore/delete.
7. **Graceful degradation** on the repointed main-app callers (spoke unreachable → surfaced error).

**Retrofit debt on the current branch:** every merged mutation slice needs its Deliverable-1 boxes closed
before it's a true replacement — track via the checklist above.
