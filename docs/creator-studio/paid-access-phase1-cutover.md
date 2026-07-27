# Phase 1 — full main-app PaidAccess cutover (task list)

**Status: plan for review.** Nothing here is implemented beyond §0. Written 2026-07-27 after the
availability/discovery audit came back clean.

## Goal & invariants

- Main app fully on PaidAccess: **reads + native writes**. Drop every main-app reference to
  `ModelVersion.earlyAccessEndsAt` / `earlyAccessPermanent` / `earlyAccessConfig`.
- EA versions become `availability='Public'`, gated **only** by PaidAccess. (Audit 2026-07-27: nothing in
  search / feed / badges / cascade depends on `availability='EarlyAccess'` — three dead clauses remain, all
  harmless.)
- **Columns + the `early_access_ends_at` trigger STAY** (dropped in Phase 2). The trigger is left live so a
  code rollback still works; with native writes it only touches unread columns + a don't-care `availability`,
  so it's harmless.
- **Spoke** is updated in Phase 2 (it may read stale columns meanwhile — acceptable, it's staging).
- **Comics** folded into this deploy (additive, mirrors the model path).

## 0. Done (branch `feat/paid-access-anchor`)

- All ModelVersion **gate** reads → `getPaidAccess` / `paidAccessActiveSql` / `isPaidAccessActive`.
- Dual-write `syncPaidAccessFromModelVersion` in place — **to be replaced by the native writer (§2)**.
- `getPaidAccess(entityType, …)` + per-entityType cache; two adversarial review passes + fixes; dead-select
  cleanup; Phase-2 coverage audit.

## 1. Read-side — flip the remaining deferred readers (mechanical, low-risk)

- **Public v1 API** `api/v1/model-versions/[id].ts` — **remove** `earlyAccessEndsAt` + `earlyAccessConfig`
  from the SELECT/response (confirmed: the API doesn't need to return EA).
- **`mini/[id].ts`** — `freeTrialLimit` / `freeGeneration` from `PaidAccess.terms` (endsAt/checkPermission
  already flipped).
- **Controller passthroughs** (`model-version.controller.ts:118/287/570`, `model.controller.ts:419`) — source
  the deadline from `PaidAccess.endsAt`; stop forwarding `earlyAccessConfig` (or reshape to `terms`).
- **Terms readers** → `PaidAccess.terms`: `creator-shop.service.getEarlyAccessModelPrices`,
  `generation.service.ts:1191/1193/1321`, and `resource-data.redis.ts` (emit terms from PaidAccess, not the
  blob).
- **`donationGoalId` back-link** — replace `earlyAccessPurchase`'s read with the forward query
  (`DonationGoal WHERE modelVersionId = X AND isEarlyAccess AND active`; the FK already exists).
- **Selectors** (`*.selector.ts`) — drop `earlyAccessConfig`/`earlyAccessEndsAt` from the fragments once their
  consumers are flipped.
- Optional: delete the 3 dead `availability='EarlyAccess'` clauses (`model.service.ts:1011`, the mod filter
  chip; the trigger guard is DB/Phase 2).

## 2. Write-side — native PaidAccess writes (the design-heavy core)

Replace `config → trigger → sync` with **direct PaidAccess writes**; stop persisting `earlyAccessConfig`.

**⚠ Design decision to settle first — pre-publish intent.** EA config (timeframe, prices, permanent) is set on
the version form **before** publish, but `endsAt = publishedAt + timeframe` can only be materialized **at**
publish. Today `earlyAccessConfig` holds that pending intent (and PaidAccess has *no row* until publish). Drop
the blob and PaidAccess must itself represent "configured, not yet published." `endsAt IS NULL` already means
*permanent*, so it can't double as "pending timed."

- **Proposed shape:** add `PaidAccess.timeframeDays int?` — `null` = permanent, `>0` = timed window length.
  Write the row when EA is configured (terms + `timeframeDays`, `endsAt = null`); **at publish**, if
  `timeframeDays` is set, materialize `endsAt = publishedAt + timeframeDays`. An unpublished version is never
  served, so its provisional active-ness is moot; post-publish `endsAt` drives the gate as today.
  *(Alternative: a separate pending-intent store — rejected as re-inventing `earlyAccessConfig`.)*
- New `writePaidAccessForModelVersion(versionId, configInput, { publishedAt }, tx)` computing
  gated / endsAt / terms / ownerId **from the write input** (no column reads). Replaces
  `syncPaidAccessFromModelVersion`.
- Rewire the writers to call it and **stop writing `earlyAccessConfig`**: `upsertModelVersion` create/update,
  `updateModelVersionEarlyAccessConfig`, `publishModelVersionsWithEarlyAccess` (materialize `endsAt` here),
  the `early-access.ts` REST endpoint.
- Retire `syncPaidAccessFromModelVersion` + its 6 call sites; keep the delete/merge PaidAccess cleanup.
- **`availability`**: stop setting `'EarlyAccess'` — leave versions `Public`. (The still-live trigger also
  pushes `Public` on the empty-config branch, so they agree.)

## 3. Expiry job + "early-access-complete" notification

- **`process-ending-early-access`** — scan PaidAccess (`endsAt IS NOT NULL AND endsAt <= now`), delete those
  rows, republish-as-New (`publishedAt = NOW()`), and set the new **`ModelVersion.earlyAccessEndedAt = NOW()`**.
  Stop the `earlyAccessConfig` breadcrumb write.
- **Additive migration**: `ModelVersion.earlyAccessEndedAt timestamptz` (the notification signal that replaces
  `originalTimeframe`).
- **Repoint** `model.notifications.ts` `early-access-complete` `prepareQuery` → `earlyAccessEndedAt >= lastSent`.
- **`donation-goal.service`** completion path — same: delete/close the PaidAccess row + set `earlyAccessEndedAt`;
  drop its raw `earlyAccessConfig` write.

## 4. Comics (fold in — additive, parallels the model path)

- Comic native writer (`entityType='ComicChapter'`, `ComicChapterTerms = { access: { price } }`, timed-only).
- Backfill migration: currently-gated `ComicChapter` rows → PaidAccess.
- Flip comic reads (`comics.router.ts:1923/1944`, cap-count `:616`, etc.) → `getPaidAccess('ComicChapter', …)`.
- Comic writers (`publishChapter` / `unpublish` / `updateChapterEarlyAccess`) → native PaidAccess.
- Comic completion notification (if any) → `ComicChapter.earlyAccessEndedAt` equivalent.

## 5. Migrations (all hand-applied)

- **This deploy (additive):** `ModelVersion.earlyAccessEndedAt`; `PaidAccess.timeframeDays` (if §2 approach);
  comics backfill; (models backfill + PaidAccess table already staged).
- **Phase 2 (NOT now):** drop `earlyAccessEndsAt` / `earlyAccessPermanent` / `earlyAccessConfig`; drop the
  `early_access` + comic EA triggers; drop the vestigial `availability='EarlyAccess'` clauses.

## 6. Verification

- Two-pass adversarial review on the native write path + comics money paths (as with the read-flip).
- `pnpm typecheck` + targeted tests (update the `__tests__` fixtures that mock the columns).

## Open decisions before I start §2

1. **`PaidAccess.timeframeDays`** (or an alternative) for pre-publish intent — confirm the shape.
2. **Comics in this deploy** — yes (assumed) / no.
3. **`earlyAccessEndedAt` on `ComicChapter`** too — only if comics has the completion notification.
