# Moderator spoke — side-effect parity checklist

Tracks the gap between the spoke's moderator mutations and the main app's full side effects, from the
three-domain audit (article / image / reports+users+cosmetics). Goal: **full side-effect parity** so the
spoke can replace the main-app moderator surface without silently dropping a side effect.

Severity: **BLOCKER** = wrong/corrupt/leaking data or broken core UX · **DEGRADED** = works but a real side
effect silently missing · **COSMETIC** = analytics/nice-to-have.

Every migrated moderation page has now been audited (original three-domain pass + the 2026-07-24 four-page
second pass). Product decisions for this app: **no feature flags / Flipt in the spoke**; **user restrictions
are handled via user role** (access is already role-gated in `hooks.server.ts` via `canAccess`).

## Master list — every open gap

Closed/clean items are in the buckets below; this table is only what's still **open**, most-severe first.

| # | Gap | Surface | Severity | Status |
|---|---|---|---|---|
| 1 | Rating-locked **Blocked** rows never unblocked on accept (`resetBlockedNsfwLevel` missing) | shared `acceptImage` (minor-review, comics-review, appeals, delegated `image.moderate`) | **BLOCKER** (regression vs `c371fcbc16`) | ✅ **DONE** — reset UPDATE before recompute in `acceptImage` |
| 2 | **KoNO finalize** dropped (vote finalize, smites, counters, pool-reset, signals) | `/images/ratings` + `/images/downleveled` `setLevel` | **BLOCKER** (downleveled) | ✅ **DONE** — delegated: spoke `syncKonoFinalize` (`kono.ts`) → new main `/api/internal/kono-finalize` runs `updatePendingImageRatings` + pool reset |
| 3 | Comic **project/chapter** mod tools not ported (TOS toggle, set project/chapter nsfw, unpublish chapter) | comic detail mod UI (not the queue) | BLOCKER-if-expected | 🅿️ **Deferred** — NOT a migrated page (this surface was never in the spoke); revisit if comic project/chapter moderation moves here. Every *migrated* page is at parity. |
| 4 | **User moderation** (ban / mute / strikes / restrictions) unbuilt | `/users` placeholder | BLOCKER-if-expected | 🅿️ **Out of scope for now** (user decision) — stays main-app until session-revoke is designed |
| 5 | `metadata.nsfwLevelReason` not written (+ `IMAGE_METADATA` bust) | `setLevel` (ratings/downleveled) | DEGRADED | ✅ **DONE** — reason + Model3D rollup + cache bust in `updateImageNsfwLevel` |
| 6 | `postId` images deleted without post-nsfw recompute | article delete | COSMETIC (~0.2%) | ✅ **DONE** — `deleteImagesByIds` now recomputes each affected post (`update_post_nsfw_levels` + `bustPostGalleryCaches`); postMetrics self-heals |
| 7 | Model3D thumbnail nsfwLevel rollup dropped | `setLevel` (ratings/downleveled) | COSMETIC (rare `postId==null` edge) | ✅ **DONE** — folded into `updateImageNsfwLevel` (#5) |
| 8 | Restore **dispute auto-resolve** dropped | article restore | COSMETIC (narrow race) | ⏳ Deferred for review — unblocked (no Flipt), but auto-**lowers** nsfwLevel; port under supervision |

Details for each are in the buckets below (search the gap name).

**Done (all spoke `check` + main `tsc` clean):** #1 `image-moderation.service.ts` (reset Blocked rows before
recompute in `acceptImage`); #5+#7 `image-nsfw-level.ts` (`updateImageNsfwLevel` stamps
`metadata.nsfwLevelReason`, rolls the level up to Model3D thumbnails, busts `IMAGE_METADATA`) + the
`/images/ratings` + `/images/downleveled` actions passing a `reason`; #6 `image-deletion.ts` +
`article-moderation.ts` (delete postId images + recompute their posts); #2 KoNO delegate (`kono.ts` +
`src/pages/api/internal/kono-finalize.ts`). Multi-agent review (3 adversarial passes) found the delegate
contract/auth/race-safety correct and the array binding correct; the one actionable finding — `acceptImage`'s
review-tags branch dropped the THUMBNAILS cache bust — is fixed. Remaining: #3 (comic project/chapter scope,
deferred), #4 (user moderation, out of scope), #8 (dispute auto-resolve, needs a call).

## Bucket A — unblocked NOW (mostly by `@civitai/storage`)

- [~] **Article delete — cover + orphaned content image cleanup** — DEGRADED (high). *(core done; 1 confirm open)*
  The spoke deleted the Article/File/ImageConnection rows + de-indexed the article, but left the cover +
  truly-orphaned content images fully live. Now replicated the main app's `deleteImageById`
  (`image.service.ts:388`) for the cover (`coverId`) + any content image with **zero remaining connections**
  — see `deleteArticleById` (`article.service.ts:1265`).
  Sub-tasks:
  - [x] Wire `@civitai/storage` client in the spoke (`storage.ts` shim + dep + `STORAGE_ENDPOINT`/`STORAGE_TOKEN`)
  - [x] Image-delete helper (`image-deletion.ts` `deleteImagesByIds`): remove from collections → delete Image
        row → `deleteObject` (S3, `b2Image`) w/ URL-dedup → `syncSearchIndex('image', delete)` →
        `IMAGE_EXISTS` sysRedis false → bust `imageMeta`/`imageMetadata`
  - [x] Wire into `deleteArticle`: capture `coverId` + content image ids before deleting connections; delete
        cover + truly-orphaned content images (`NOT EXISTS` ImageConnection). URL-dedup guard included.
  - [x] **Storage app tested functional** — `STORAGE_ENDPOINT`/`STORAGE_TOKEN` pulled from the civitai main
        worktree `.env` (localhost:8084). `/health` OK; auth enforced (401 w/o token); `head`/`delete`/
        `delete-many` all 200 with the token.
  - [x] **Backend confirmed — `b2Image` for all images.** Real image keys from the DB (oldest id=127 →
        newest) all `head` as `exists:true` on `b2Image`, `false` on `default`/`b2`. The backblaze migration
        is complete → no legacy-R2 concern; the hardcoded `b2Image` is correct.
  - [x] **Resize/CDN purge — confirmed + replicated.** Read `apps/storage/src`: `/objects/delete` is a pure
        S3 `DeleteObjectCommand`, **no** resize/CDN purge. Added `purgeResizeCache` to `image-deletion.ts`
        (best-effort POST to `IMAGE_CACHER_URL/admin/invalidate`, parity with the main app). `IMAGE_CACHER_URL`
        wired (empty in local dev → no-ops, matching the main app; prod sets it).
  - [x] **postId images — DONE.** `deleteImagesByIds` collects every deleted image's `postId` and, after the
        batch, runs `update_post_nsfw_levels` + `bustPostGalleryCaches` (the spoke's `bustCachesForPosts`
        port) for those posts. `deleteArticle` no longer excludes postId images (matching `deleteArticleById`,
        which deletes cover + truly-orphaned content images regardless of postId). `postMetrics.queueUpdate`
        is intentionally NOT mirrored — it enqueues to the main app's bucket-based metric queue (unsafe to
        partially reimplement) and the post imageCount self-heals on the next metrics delta-scan.
- [x] **Article delete — ClickHouse `article` Delete analytics** — COSMETIC. **DONE.** `recordArticleDeleted`
  in `article-moderation.ts` inserts `{ userId: moderator, type: 'Delete', articleId, nsfw: false }` into the
  CH `articles` table — parity with `ctx.track.article({type:'Delete'})` (`article.router:110`). Best-effort.

## Bucket B — no infra needed, just work

- [x] **Restore — ingestion-override precedence** — DEGRADED (correctness). **DONE.** Added
  `hasModeratorOverride → 'Scanned'` as the top-precedence branch in `restoreArticle`'s inlined derivation
  (`article-moderation.ts`), plus `moderatorNsfwLevel` to the fetch. A restored mod-pinned article whose
  cover/content image is still Pending/Error now stays `Scanned` (visible), matching `deriveArticleIngestionState`.
- [x] **Model3D unpublish — `userContentOverviewCache.refresh`** — DEGRADED. **DONE.** `unpublishModel3d`
  now fetches the owner `userId` and busts the three model3d overview counters (`model3dCount`, `:sfw`,
  `:public`); lazy recompute on next read, matching the article-restore bust pattern. Only the model3d
  counters change on unpublish, so the full `refresh()` fan-out isn't needed.
- [ ] **Restore — dispute auto-resolve** — COSMETIC. **DEFERRED (confirmed real gap).** The removed
  `restoreArticleById` called `updateArticleImageScanStatus` → `dispatchArticleIngestionPostCommit` →
  `maybeAutoResolveDisputeAfterScan`; the spoke restore inlined only the in-tx recompute, so it dropped the
  auto-resolve. The main-app helper is Flipt-gated, but **this app uses no feature flags** — so the port simply
  drops the flag check (feature is on) and needs `evaluateAutoApproveGate` + `autoResolveArticleRatingReview`
  (resolve-existing) ported. Keep the gate — skipping it would wrongly auto-approve disputes. Narrow race (owner
  disputed while unpublished, restore flips status→Published + ingestion→Scanned). Port the gate + auto-resolve
  onto the restore path, or delegate to the main app.
- [~] **Prohibited-prompts — "flag as suspicious" sysRedis write** — **RECLASSIFIED (not a prohibited-prompts
  gap).** `saveSuspiciousMatches` lives on the main app's `generation-restrictions.tsx` page, not the
  prohibited-prompts page. The spoke's `/users` (generation-restrictions) surface is an unbuilt placeholder
  (Bucket C — user moderation, delegate). There is no spoke mutation whose side effect this is — porting a
  sysRedis-write helper with no caller would be dead code. Handle when generation-restrictions is ported/delegated.
- [~] **Scanner `deleteLabelVerdict`** — **RECLASSIFIED (no main-app operation to port).** There is no
  `deleteLabelVerdict` in the main app; `scanner-policies-dataset.service` only *reads* `ScannerLabelReview`
  (to build export datasets). The scanner-audit review is spoke-native and the spoke's verdict endpoint upserts
  correctly. "Clear a verdict" would be a new spoke feature, not a dropped side effect — nothing to port.

## Second-pass audit — the remaining migrated pages (2026-07-24)

Four parallel audits of every migrated mutation surface not covered by the original three-domain pass.
**Clean (full parity, no material drops):** `/articles/ratings` (rating-review resolve), `/images/ingestion-errors`,
`/images/tags`, and the `/comics-review` **queue** approve/block (delegates to the shared `acceptImage`/`blockImage`,
comic re-queue included). `prompt-tester`/`page-visits`/`users`/`admin` are read-only, spoke-native, or placeholders.
New gaps found:

- [ ] **Shared image-accept — rating-locked Blocked rows never unblocked** — **BLOCKER (regression).** The main
  app's `handleUnblockImages` runs `resetBlockedNsfwLevel(ids)` (`image.service.ts:740`: `UPDATE Image SET
  nsfwLevel=0, nsfwLevelLocked=FALSE WHERE nsfwLevel=Blocked`) **before** recompute, because
  `update_nsfw_levels_new` skips locked rows (`update_nsfw_level.sql:68`: `AND NOT nsfwLevelLocked`). The spoke's
  `acceptImage` (`image-moderation.service.ts`) never unlocks, so an image rating-locked at Blocked stays hidden
  after a mod explicitly unblocks it. Affects **minor-review, comics-review queue, appeals-approve, and the
  delegated `image.moderate` unblock**. This is exactly what main commit `c371fcbc16` (#3355) fixed; the spoke
  port predates/missed it. Cheap: add the unlock UPDATE before `recompute` in `acceptImage`.
- [ ] **`/images/ratings` + `/images/downleveled` `setLevel` — `metadata.nsfwLevelReason` not written** —
  DEGRADED. The shared `updateImageNsfwLevel` (`image-nsfw-level.ts`) sets only `nsfwLevel`/`nsfwLevelLocked`;
  the main app also writes `metadata.nsfwLevelReason` (`image.service.ts:6350`) and busts `imageMetadataCache`
  (`:6354`). Portable — the sibling `ingestion.service.ts` already does both in-spoke; just wire them into the
  shared setter (also busts `IMAGE_METADATA`, which is otherwise a stale-cache COSMETIC once the write lands).
- [ ] **`/images/ratings` + `/images/downleveled` `setLevel` — Model3D thumbnail rollup** — COSMETIC. Main calls
  `updateModel3DNsfwLevelForThumbnailImage` (`image.service.ts:6364`); only fires for a standalone model3d
  thumbnail (`postId==null`). Portable (PG), rare edge.
- [ ] **Comic project/chapter-level mod tools — not ported at all** — **BLOCKER-if-expected.** A surface distinct
  from the review queue (the comic detail mod UI, `comics.router.ts`): `setTosViolation` (:5078),
  `setProjectNsfwLevel` (:5126), `setChapterNsfwLevel` (:5168), `moderatorUnpublishChapter` (:5211). Each does a
  DB write + creator `tos-violation`/mod notification + `trackModActivity` + Meilisearch update, and
  `moderatorUnpublishChapter` force-drafts a chapter. All the infra exists in the spoke (Kysely, notifications,
  mod-activity, `syncSearchIndex`→main). **Needs a product decision: does the spoke own comic project/chapter
  moderation, or does it stay in the main app?**

## Bucket C — needs a decision (port vs delegate), not more packages

- [ ] **Image nsfwLevel-set — KoNO finalize** — **DEGRADED→BLOCKER for the downleveled queue.** Confirmed to
  fire from the **`/images/ratings` + `/images/downleveled` `setLevel`** path (main: `handleUpdateImageNsfwLevel`
  isModerator branch → `updatePendingImageRatings` → `new-order.service.ts:763`), NOT the block/accept path. The
  main app finalizes pending Knights-of-New-Order votes (ClickHouse `knights_rating_updates_buffer` +
  `processFinalRatings` → `knights_new_order_image_rating`), decrements `NewOrderSmite` + `cleanseSmite`, updates
  player counters (fervor/exp/correctJudgments, Redis), removes the image from the KoNO review pool
  (`pool.reset`, Redis), and emits **WebSocket signals** (`NewOrderPlayerUpdate/UpdateStats`). The spoke's
  `setLevel` drops all of it. Especially load-bearing for **downleveled** (those items were downleveled *by* the
  KoNO game — a mod correction there is the feedback that finalizes votes). The spoke has ClickHouse + Redis but
  **no signals client**, and this is real game-engine logic.
  **Recommendation: DELEGATE to the main app via `/api/mod/[action]`** (the pattern the `image.moderate` cutover
  established) rather than porting the new-order engine + signals. The pool-reset + counters are Redis-portable
  in isolation, but the signal emit is not — delegating the whole chain keeps it coherent.
- [ ] **User moderation** (ban / mute / strikes / restrictions) — **BLOCKER-if-expected**
  (currently unbuilt; `/users` is a placeholder). Product direction: **restrictions are role-based** (no
  feature flags), and moderator access is already role-gated in `hooks.server.ts` via `canAccess`.
  Notifications/email/buzz exist; the remaining hard dependency is **session invalidation** — a ban / role
  downgrade must revoke the user's live sessions, which is an auth-hub (`@civitai/auth`) concern the spoke
  can't do alone. **Recommendation: DELEGATE to the main app** (or have the auth hub expose a "revoke user
  sessions" primitive) rather than porting the session/strike machinery into the spoke.
  The `generation-restrictions` "flag as suspicious" sysRedis write (see Bucket B) lands with this surface.

## Already at full parity (no action)

Reports set-status + reporter reward · cosmetics grant · blocklists · scanner verdict upsert · image
block/accept/appeal · article rating-review resolve.

## Infra availability (what unblocks what)

| Capability | Package | In spoke? | Unblocks |
|---|---|---|---|
| S3 object delete | `@civitai/storage` (client → storage app) | **newly wired** | article-delete image cleanup |
| Redis / sysRedis | `@civitai/redis` | ✅ already | Model3D refresh, prohibited-prompts, existence/meta caches |
| ClickHouse | `@civitai/clickhouse` | ✅ already | article-delete analytics, KoNO buffer |
| Notifications / email / buzz | `@civitai/notifications` / `@civitai/email` / `@civitai/buzz` | ✅ already | (appeal email etc. already done) |
| Meili enqueue | `syncSearchIndex` → main app | ✅ already | image/article index deletes |
| WebSocket signals | — | ❌ none | KoNO finalize (→ delegate) |
| Session invalidation | `@civitai/auth` (hub) | ❌ not exposed | user moderation (→ delegate) |

**Answer to "is storage + redis enough for full parity?"** They close Bucket A (storage does the heavy
lifting) and confirm Bucket B is just work — but full parity also needs the Bucket B fixes and a
port-vs-delegate decision for Bucket C (KoNO finalize + user moderation), where the missing pieces are
signals + session-invalidation, not more storage/redis.
