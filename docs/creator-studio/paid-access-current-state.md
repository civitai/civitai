# PaidAccess — current state (continued-work reference)

**Start here to continue paid-access work.** This is the living "where things are now" doc, written after the
permanent Paid Access + usage-control pricing work landed (2026-07-29, commit `a0535931f5` on
`creator-studio-implementation`). For the data shapes + terms semantics see
[paid-access-schema.md](paid-access-schema.md). The phase-1 cutover is done; its process/plan/review docs were
removed and the still-open signal from them is consolidated below (see [History](#history)).

## The model in one paragraph

Gating lives in the **`PaidAccess`** table, keyed `(entityType='ModelVersion', entityId)`. `endsAt` is the one
gate signal: **NULL = permanent** ("Paid Access"), **future = active timed** ("Early Access"), **past = expired**.
`timeframeDays` is the pre-publish window length (NULL = permanent). `terms` is JSON: `{ download?: {price},
generation?: {free:true} | {price?, trialLimit?} }` with **bundle semantics** — buying `download` grants
generation too. Early-access state is derived **live** from an active `PaidAccess` row (nothing reads the dropped
`earlyAccessConfig`/`earlyAccessEndsAt` columns anymore).

## What's built

- **Timed Early Access + Permanent Paid Access.** Permanent = `endsAt IS NULL`. Permanent is a Creator Program
  perk, **capped per tier** (`PERMANENT_ACCESS_LIMIT_BY_TIER` = bronze 3 / silver 10 / gold ∞) via
  `maxPermanentAccessModels(tier)`. Enforced server-side on every write path, with an **already-permanent
  carve-out** (a lapsed/at-cap creator can still re-save a version that's already permanent). Permanent is
  **settable post-publish**; a *timed* window can't be *started* after publish.
- **Usage-control-aware pricing.** One required **"Price for access"** everywhere:
  - `Download` → `download.price` (bundle) + an optional cheaper **generation-only** tier (`generation.price`).
  - `Generation` (on-site-gen-only) → the access price **is** the generation price (`generation.price`, **no
    download tier**); the generation-only field is hidden.
  - `InternalGeneration` / `ExternalGeneration` → **cannot be gated** at all.
  - Free preview generations = `generation.trialLimit`.
- **Donation goal** — timed-only (it ends a window early; permanent never ends) and **create-once** (the endpoint
  never updates/removes it, so the spoke shows an existing goal read-only).
- **Bulk permanent paid access** (Creator Studio) — scoped by a **usage-type filter** (`?usage=download|generation`
  drives the list + select-all so the price fields are unambiguous); selection is capped at `cap − current`.

## Where the code lives

**Shared — `packages/civitai-buzz/src/paid-access.ts`**: the terms types, `buildModelVersionTerms()` (the single
config→terms mapper both apps call), the grant/gating helpers (`grantsGeneration`, `isPaidAccessActive`,
`generationPrice`, `generationTrialLimit`), and `PERMANENT_ACCESS_LIMIT_BY_TIER` / `maxPermanentAccessModels`.

**Main app**
- Form: `src/components/Resource/Forms/ModelVersionUpsertForm.tsx` — `toPaidAccessInput`/`toFormEarlyAccessConfig`/
  `toGate`, the pricing `.refine()`s, `canConfigurePaidAccess`, `isGenOnly`/`paidAccessUsageOk` UI gating.
- Server: `controllers/model-version.controller.ts` (permanent membership + tier-cap + carve-out);
  `services/model-version.service.ts` (usage-control guards on **both** the upsert path and
  `updateModelVersionPaidAccess`); `services/paid-access.service.ts` (`getPaidAccess`,
  `countUserPermanentAccessVersions`, `assertPaidAccessInput`); `services/generation/paid-access-gating.ts` (the
  **sole** generation-gate enforcement); download gate in `services/file.service.ts`.
- REST boundary (the spoke calls this): `pages/api/v1/model-versions/early-access.ts` — body `{ id, paidAccess,
  donationGoal }`; permanent requires the `WEBHOOK_TOKEN`.

**Creator Studio spoke** (`apps/creator-studio/`)
- Page: `src/routes/(app)/models/+page.svelte` (drawer + list) using components
  `src/lib/components/PaidAccessEditor.svelte`, `PaidAccessBulkBar.svelte`, `BulkLicensingFeesBar.svelte`.
- Actions/schemas: `src/routes/(app)/models/+page.server.ts` (`setEarlyAccess`, `bulkSetPaidAccess`, the query +
  bulk schemas); field factories in `src/lib/server/monetization/form-fields.ts`.
- Reads: `src/lib/server/models.ts` (`paidAccessToConfig`, the `usage` filter, `paidAccessFilter`).
- Writes/counts: `src/lib/server/monetization/early-access.ts` (`setEarlyAccessConfig` → REST endpoint,
  `bulkSetPermanentAccess`, the count helpers, `isVersionPermanent`).
- Shared type/constants: `src/lib/monetization/early-access.ts` (`EarlyAccessConfig`, `MIN_ACCESS_PRICE`, etc.).

## Verified

Purchase → access is **correct end-to-end** (audited): buying `download` grants download+generation (perms `3`),
buying generation grants generation (`1`); permanent buyers never lose access (no `EntityAccess` expiry; the
expiry cron excludes permanent rows); the **orchestrator** meters free-trial counts per user and checks the
`EarlyAccessGeneration` bit (external, confirmed — don't re-flag as a bug). `pnpm typecheck` (main) and
`pnpm --filter @civitai/creator-studio-app check` (spoke) both pass 0 errors.

## Gotchas (non-obvious)

- **Gen-only price round-trip:** for a gen-only version the access price is stored in `generation.price` (no
  download tier), so reads must source it as `download?.price ?? paidGen?.price` — see `paidAccessToConfig`
  (`models.ts`) and `toFormEarlyAccessConfig` (form). `buildModelVersionTerms` **ignores** `generationPrice` when
  `genOnly` (the access price is the generation price).
- **Donation goal is create-once** — can't be changed/removed via the endpoint; the spoke locks an existing goal.
- **Naming drift:** the spoke's write API still uses `earlyAccess*` names (`setEarlyAccessConfig`,
  `?/setEarlyAccess`, `EarlyAccessConfig`, `hasEarlyAccess`) even though they now cover permanent Paid Access too.
  The Svelte components were renamed to `PaidAccess*`; the API rename is a deferred follow-up.

## Open / next

- **CSV export/import** does **not** yet include paid/early-access columns. Parked pending scope; recommendation:
  export the columns first (read-only round-trip), then a separate import pass (it's a CSV-driven bulk-mutation
  through the endpoint with cap/membership/usage enforcement). Donation goal should be a **read-only** column.
- **Free-previews "clear" semantics differ** across the two apps: spoke empty → **0**, main-app cleared → default
  **10**. Both edit the same versions — decide one semantic and align.
- **Runtime smoke-test** the Svelte component extractions (state seeding on drawer reopen; shared `selected`
  reactivity across the bulk bars) — type-check can't catch reactivity regressions.

### Flagged in the phase-1 reviews (verify against current code)

These predate this session's work; the review docs themselves were deleted, so the findings live here now.

- **Scheduled early-access never materializes `endsAt` → becomes a permanent gate that never releases.** A
  version published with a *future* `publishedAt` goes `status=Scheduled`, skips the EA branch (which requires
  `Published`), so `materializePaidAccessEndsAt` never runs; `process-scheduled-publishing.ts` (~:238) then
  re-publishes it **without** `publishedAt`, so it's skipped again. `endsAt` stays NULL forever = permanent, and
  `process-ending-early-access` (filters `endsAt <= NOW()`) never releases it. Fix shape: one
  `applyPublishedAt(tx, versionId, publishedAt)` owning both the anti-bump SQL and the materialize, used by all
  publish sites. **Money/access-relevant — verify still reproducible.**
- **`mini/[id].ts:~148` free-trial-limit SQL uses the wrong predicate.** It gates on
  `terms->'generation'->>'price' IS NOT NULL`, but the common path (a download bundle, or gen-only) emits
  `generation: { trialLimit: N }` with **no `price`**, so the SQL returns `NULL` free-trial-limit for the default
  case — the free-preview count may not surface to the orchestrator. Predicate should be `terms ? 'generation' AND
  COALESCE(terms->'generation'->>'free','') <> 'true'`. Note `@civitai/buzz` exports `paidAccessActiveSql` /
  `isPaidAccessGated` with **zero call sites** while ~6 raw-SQL sites hand-roll "active gate" — consolidating onto
  the shared helpers would fix this class.
- **`earlyAccess*` naming rename** (deferred): the spoke's write API is still named for early access though it
  covers permanent Paid Access — see Gotchas above.

## History

The phase-1 cutover — add the `PaidAccess` table, backfill, dual-write, main-app read sweep, spoke conversion,
then drop the legacy `earlyAccessConfig`/`earlyAccessEndsAt`/`earlyAccessPermanent` columns — is **complete**. The
migration record lives in `prisma/migrations/`. The phase-1 plan/review/cutover process docs and the applied
catch-up backfill SQL were removed as no-longer-current; their still-open findings are consolidated in
[Flagged in the phase-1 reviews](#flagged-in-the-phase-1-reviews-verify-against-current-code) above.
