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

### Image accept — `acceptImage`  ·  (images minor/poi/…, comics-review approve)
- [ ] Remove pHash from blocklist (`bulkRemoveBlockedImages`) — **ClickHouse `blocked_images`** — else re-uploads keep auto-blocking
- [ ] Bust post/gallery caches (`bustCachesForPosts`) — **Redis**
- [ ] Refresh thumbnail cache (in the recompute) — **Redis**
- [ ] Re-queue parent comic(s) (`queueComicsForPanelImages`, all comics containing the image) — **comic search-index**
- [ ] Auto-resolve appeal when `needsReview==='appeal'` (`resolveEntityAppeal(Approved)`) — **appeal cascade**

### Image block — `blockImage`  ·  (images, comics-review block)
- [ ] Add pHash to blocklist (`bulkAddBlockedImages`) — **ClickHouse `blocked_images`** — else identical re-uploads aren't auto-blocked
- [ ] Notify uploader (`createNotification` `tos-violation`) — **notifications**
- [ ] `DeleteTOS` analytics (`ctx.track.images`, + collect `violationType`/`violationDetails`) — **ClickHouse** — feeds appeal `tosReason` + strike analytics
- [ ] Invalidate image-exists cache (`invalidateManyImageExistence`) — **Redis (sysRedis)**
- [ ] Bust post/gallery caches (`bustCachesForPosts`) — **Redis**
- [ ] Re-queue parent comic(s) — **comic search-index**

### Image appeal resolve — `resolveImageAppeal`  ·  (images appeals)
- [ ] Refund appeal fee on approve — **buzz**
- [ ] Notify appellant (`entity-appeal-resolved`) — **notifications**
- [ ] Appeal-resolution email — **email**
- [ ] Re-queue parent comic + bust post caches + refresh thumbnail cache — **comic index / Redis**
- [ ] Persist `internalNotes` — **DB** (minor)

### Image nsfwLevel set — `updateImageNsfwLevel`  ·  (image-rating-review, downleveled-review)
- [ ] Stamp `metadata.nsfwLevelReason` — **DB**
- [ ] Refresh `imageMetadataCache` — **Redis**
- [ ] Re-derive Model3D nsfwLevel for thumbnail images — **DB rollup**
- [ ] Finalize Knights-of-New-Order votes (`updatePendingImageRatings`) — **ClickHouse + KoNO**
- [ ] Remove image from new-order pools (`pool.reset`) — **Redis (new-order)**

### Ingestion error resolve — `resolveIngestionError`  ·  (ingestion-error-review)
- [ ] Refresh `imageMetadataCache` + `tagIdsForImagesCache` — **Redis** (already `TODO`-marked)

### Reports set-status — `setReportStatus`  ·  (reports)
- [ ] Reward reporter(s) on Actioned (`reportAcceptedReward`, incl. `alsoReportedBy`, with `ip`) — **buzz + ClickHouse**

### Article restore — `restoreArticle`  ·  (articles)
- [ ] Recompute ingestion state (`recomputeArticleIngestionInTx`) — **DB**
- [ ] Owner ingestion notifications — **notifications**
- [ ] Refresh `userArticleCountCache` + replication-lag guards — **Redis / infra**

### Article delete — `deleteArticle`  ·  (articles)
- [ ] Delete cover image + orphaned content images (`deleteImageById`) — **DB + S3 + CDN**

### Article rating resolve — `resolveArticleRatingReview`  ·  (article-rating-review)
- [ ] Notify owner (`article-rating-review-approved`/`-rejected`, with level labels + modComment) — **notifications**

---

## Deliverable 2 — De-duplication endpoints (`/api/mod/[action]`)

Only the migrated-page mutations that are **moderator-only AND still called by a live main-app surface**. These
get lifted into a spoke endpoint (the single implementation), and the main-app callers are repointed + the
main-app procedure deleted. Everything else stays spoke-owned (no endpoint).

### ✅ Endpoint: `image-moderate`  *(the one that matters)*
- Backs: the spoke's `acceptImage`/`blockImage`/`resolveImageAppeal` **and** the main app's `image.moderate`
  (callers `NeedsReviewBadge`, `UnblockImage`) + `image.setTosViolation`.
- Plan: complete it to full fidelity (Deliverable 1's Image sections), expose at `/api/mod/image-moderate`,
  repoint the three main-app callers, delete main-app `moderateImages`/`handleBlock`/`handleUnblock` +
  `image.moderate` procedure. This is both the biggest fidelity gap and the biggest "lighter main app" win.

### ✅ Endpoint: `report-set-status`
- Backs: the spoke's `setReportStatus` **and** the main app's `bulkSetReportStatus` (callers
  `pages/api/mod/action-report.ts`, `csam.controller.ts`).
- Plan: complete it (Deliverable 1 reporter-reward), expose at `/api/mod/report-set-status`, repoint the two
  main-app callers, delete main-app `bulkSetReportStatus`.

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

## Architecture — the `/api/mod` surface (for the 2 endpoints above)

```
apps/moderator/src/lib/server/mod-actions/
  registry.ts            # action -> { schema (zod), handler, requiredRole }
  image-moderate.ts      # full-fidelity handler (all side effects)
  report-set-status.ts
apps/moderator/src/routes/api/mod/[action]/+server.ts   # cross-site entry (main app -> spoke)
```

- **Handlers** own the complete operation against the spoke's wired infra: `(input, actor) => Result`.
- **Registry** is the single catalog; both entry points dispatch through it.
- **`/api/mod/[action]`** — POST, internal-token auth (mirror of the `syncSearchIndex` token the spoke already
  uses toward the main app), look up `action`, validate body against its `schema`, run `handler(input, actor)`,
  return JSON. `actor.userId` is asserted by the trusted caller (the main app already checked the session).
  Exempt `/api/mod/*` from the nav role-gate in `hooks.server.ts` (it self-authorizes).
- **Spoke form actions** call `dispatch(action, input, { userId: locals.user.id })` — same registry path — so
  the migrated pages and the main-app callers run identical code. `+page.server.ts` actions stay thin.

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
5. **Same for `report-set-status`**: complete reporter-reward, register, repoint `action-report` +
   `csam.controller`, delete `bulkSetReportStatus`.
6. **Finish the page-only fidelity gaps** (Deliverable 1: nsfwLevel, ingestion, article restore/delete/rating)
   as direct spoke service work — no endpoint. Remove orphaned main-app article restore/delete.
7. **Graceful degradation** on the repointed main-app callers (spoke unreachable → surfaced error).

**Retrofit debt on the current branch:** every merged mutation slice needs its Deliverable-1 boxes closed
before it's a true replacement — track via the checklist above.
