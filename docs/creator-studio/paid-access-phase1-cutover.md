# Phase 1 — full main-app PaidAccess cutover (task list)

**Status: implemented** on branch `feat/paid-access` (native reads + writes landed; consistency review
applied). Written 2026-07-27 after the availability/discovery audit came back clean. A few things were
built differently than first planned — see **Divergences from this plan** at the end before trusting a
detail here.

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

- All ModelVersion **gate** reads → `getPaidAccess` / `isPaidAccessActive` (the unused `paidAccessActiveSql`
  helper was later deleted; `isTimedGateActive` covers the "active timed window" rule).
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

- **This deploy (additive):** `PaidAccess.timeframeDays`; comics backfill; (models backfill + PaidAccess
  table already staged). **No `ModelVersion.earlyAccessEndedAt` column** — the implemented expiry design
  keeps the PaidAccess row as a tombstone (`endsAt` in the past) and windows the notification on `pa."endsAt"`
  instead (see Divergences).
- **Phase 2 (NOT now):** drop `earlyAccessEndsAt` / `earlyAccessPermanent` / `earlyAccessConfig`; drop the
  `early_access` + comic EA triggers; drop the vestigial `availability='EarlyAccess'` clauses.
  - **`Model.earlyAccessDeadline` (now code-unused):** Phase 1 stopped reading/writing it — early-access
    state is derived live from `PaidAccess` everywhere (feed/shop filters use `EXISTS` over PaidAccess;
    the Meili index projects the deadline from PaidAccess at sync time; gate writes queue a re-index).
    Drop the column (`ALTER TABLE "Model" DROP COLUMN "earlyAccessDeadline"`) once the read-side is
    verified in prod. Also remove/hide the now-meaningless `EarlyAccess` chip from the model feed's
    **availability** filter (it matches `Model.availability='EarlyAccess'`, which is never set — use the
    Early Access *toggle* instead).
  - **`DonationGoal` cleanup (all now code-unused):** drop `DonationGoal.modelVersionId` (+ its FK and the
    `donation_goal_fill_entity` transition trigger) and make `(entityType, entityId)` the primary key; drop
    `DonationGoal.isEarlyAccess` (EA-ness is derived live from the entity's `PaidAccess` record — no flag) and
    `DonationGoal.paidAmount` (code-unused, never written). Also re-key `Donation` off the numeric
    `donationGoalId` (give it the entity reference) so the goal's `id` can go.
  - **Naming:** the now-dead `ModelVersionEarlyAccessPurchase` / `earlyAccessPurchase` names still say
    "early access" though they write a generic gate — rename to PaidAccess when the copy churn is worth it.

### Phase 2 progress (branch `feat/paid-access-phase2`, uncommitted — hold until cutover complete)

**Done — schema + code, all verified (`db:generate` clean, `typecheck` 0 errors, 1820 unit tests green).
All drops live in one hand-applied migration `20260728120000_phase2_drop_legacy_early_access`:**
- `Model.earlyAccessDeadline`.
- `DonationGoal.paidAmount` + `isEarlyAccess`.
- `ModelVersion.earlyAccessConfig` / `earlyAccessEndsAt` / `earlyAccessPermanent` **+ the `early_access`
  trigger + `early_access_ends_at()` function**. Model-only; **ComicChapter's own columns/trigger are left
  intact** (comics stay on the legacy path until stage 5, per decision 2). Verified the native publish path
  sets `availability='Public'` itself (`publishModelVersionsWithEarlyAccess`) and the column defaults to
  Public, so dropping the trigger does not change publish behavior.

**Blocked on prod data (NOT a plan decision — the planned migration cannot run as-is):**
- **`DonationGoal` → `(entityType, entityId)` PK + `Donation` re-key.** `ADD PRIMARY KEY (entityType,
  entityId)` fails against current prod: of 21,944 goals, **482 are orphans** (version hard-deleted →
  `modelVersionId` and entity-ref both NULL; **90 have real `Donation` rows**, **473 are still `active`**),
  and **15 entities carry duplicate goals** (**32 active goals** among them, so the pair isn't unique).
  Resolving means deleting/merging goals that have **donation records attached** — a data-cleanup call on
  financial rows, not something to auto-apply. Everything downstream (drop `modelVersionId`+FK, drop the
  `donation_goal_fill_entity` trigger, re-key `Donation` off `donationGoalId`) waits on that cleanup.

**Skipped — plan marks optional:**
- **Delete the dead `availability='EarlyAccess'` clauses** (§1 "Optional:"). Left in place — the
  `hidePrivateModels` filter (`model.service.ts:~1051`) still *includes* `EarlyAccess`, so removing it
  would hide migrated versions that legitimately carry that availability until their gate expires. Harmless
  to leave; removal is a net-zero that isn't worth the risk.
- **Rename `earlyAccessPurchase` / `ModelVersionEarlyAccessPurchase` → PaidAccess** ("when the copy churn
  is worth it"). Touches `track.schema.ts` analytics event *strings* (historical events key on the old
  name) — a rename must preserve those string values, so it's deferred as a deliberate follow-up.

## 6. Verification

- Two-pass adversarial review on the native write path + comics money paths (as with the read-flip).
- `pnpm typecheck` + targeted tests (update the `__tests__` fixtures that mock the columns).

## Open decisions before I start §2 — all settled

1. **`PaidAccess.timeframeDays`** — YES, adopted (materialized into `endsAt` at publish).
2. **Comics in this deploy** — NO, deferred to stage 5 (contradicts §4's "fold in"; comics remain on the
   legacy path until then).
3. **`earlyAccessEndedAt`** — DROPPED entirely (no such column; tombstone + `endsAt`-window design instead).

## Divergences from this plan

The implementation departed from this plan in a few places (all deliberate, all better):

- **No `ModelVersion.earlyAccessEndedAt` column / no row deletion at expiry.** §3/§4 above call for a new
  column as the expiry+notification signal and "delete those rows" in the expiry job. Instead the expiry job
  (`process-ending-early-access.ts`) republishes and leaves the PaidAccess row as a **tombstone** (`endsAt`
  set to the past), and `model.notifications.ts` windows `early-access-complete` on `pa."endsAt"`. One fewer
  column, and completion/expiry share one uniform "endsAt in the past" signal.
- **Terms are NOT emitted from `resource-data.redis.ts`.** §1 planned to have the resource-data cache emit
  terms from PaidAccess. That cache has a 1h TTL and would serve stale gating terms, so PaidAccess is instead
  merged into generation resources at read time (`mergePaidAccess`, from the short-lived/busted
  `getPaidAccess` cache). The generation resource no longer carries a `donationGoal` field at all — it was
  write-only (nothing read it), so it and its cache fetch were removed.
- **Donation goals are one-per-entity and read like PaidAccess.** `getDonationGoals(entityType, ids)` mirrors
  `getPaidAccess`; the owner/privileged read is `getOwnerDonationGoals`. The completion path
  (`checkDonationGoalComplete`) is entity-generic — no `isEarlyAccess` flag; whether a completed goal ends a
  gate is read from the entity's PaidAccess record via `endPaidAccessNow`.
- **Comics deferred** to stage 5 (see decision 2), so this deploy is model-only despite §1.4/§4 wording.

## Resolved decisions

- **Public REST `GET /api/v1/model-versions/[id]` drops `earlyAccessEndsAt` + `earlyAccessConfig`** —
  **DECIDED (2026-07-28): drop them.** The public v1 API should not surface paid-access gate details, and
  there are no active consumers. This supersedes the `paid-access-query-sites.md` audit note (which had said
  to reconstruct, not delete). If it ever needs to change, reconstruct from `PaidAccess.endsAt`/`terms` as
  `mini/[id].ts` does. (Note in `src/pages/api/v1/model-versions/[id].ts`.)

## Parity regressions found + fixed (post-review)

A parity review against the base commit surfaced two behavioral regressions, both fixed:

- **Free-generation resources became non-generatable.** A `{ generation: { free: true } }` version resolved to
  `canGenerate=false` for non-owners (the old default `generationTrialLimit: 10` had always made the
  hasAccess fallback truthy). Fixed in `generation.service.ts` — the fallback now treats
  `isFreeGeneration(terms)` as access-granting.
- **Early goal completion stopped recomputing `Model.earlyAccessDeadline`.** The old `checkDonationGoalComplete`
  called `updateModelEarlyAccessDeadline` + refreshed the mv/dataForModels caches when a goal met early; the
  refactor dropped this, leaving the model in EA feed filters + a false badge until the original deadline.
  Restored via an entity-dispatched `syncModelAfterEarlyGateEnd` helper (fail-open, ModelVersion-only).

Rollout notes that were reviewed and intentionally left as-is: the `RESOURCE_DATA` redis key stays
`…-3` (deploy-window staleness accepted); the `modelVersion.donationGoals`→`donationGoal` route rename +
array→single reshape is a deliberate cross-app break (spoke updates in phase 2).
