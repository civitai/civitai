# PaidAccess Phase 1 — Review & Test Guide

**Goal of this review:** confirm the change is **functionally the same as before** for early-access and
donation-goal behavior, so it can merge to `main`. This is a money/access-control change, so review
starts at the access decision and works outward — not top-to-bottom.

## The one concept to load first

Gating moved **off** the `availability` enum and **onto** a new polymorphic
`PaidAccess(entityType, entityId)` table. Access is now derived *live* from a cached DB row (`endsAt`,
`terms`) instead of from `availability='EarlyAccess'` + scattered `earlyAccessConfig` JSON.

Two consequences that everything else follows from:

- **Migrated versions** keep `availability='EarlyAccess'` and gain a PaidAccess row (backfill inserted a
  row **iff** the gate was active/permanent — see the 469-vs-760 note below).
- **New gates** are written with `availability='Public'`; the gate lives *only* in PaidAccess. Enforcement
  therefore cannot key on the enum anymore — it must consult PaidAccess.

## Scope — what to review, what to ignore

**In scope (the change set, `origin/main..HEAD` minus the merge commit):**

| Area | File | Anchor |
|---|---|---|
| Terms interpreter (pure) | `packages/civitai-buzz/src/paid-access.ts` | `grantsGeneration` L101, `generationOpenToNonBuyers` L93, `isPaidAccessActive` L68 |
| Read/download access gate | `src/server/services/common.service.ts` | `hasEntityAccess` L135–210 |
| Generation paywall (sole enforcement) | `src/server/services/generation/paid-access-gating.ts` | `applyPaidAccessGating` L41 |
| Generation pipeline wiring | `src/server/services/generation/generation.service.ts` | call site L1298 (inside `getResourceData`) |
| PaidAccess write/cache | `src/server/services/paid-access.service.ts` | `writePaidAccessForModelVersion` L164, `materializePaidAccessEndsAt` L227, `endPaidAccessNow` L147, cache L58 |
| Purchase + caps | `src/server/services/model-version.service.ts` | `earlyAccessPurchase` L1747, `assertUserEarlyAccessLimits` L305 |
| Donation goal → gate end | `src/server/services/donation-goal.service.ts` | `checkDonationGoalComplete` L318 → `endPaidAccessNow` L343 → `syncModelAfterEarlyGateEnd` L382 |

**Out of scope (do not spend time here):**

- The **109-commit merge from `main`** is diff noise. Review against the merge base
  (`git diff $(git merge-base origin/main HEAD) HEAD -- <paths above>`).
- **Comics / ComicChapter** early-access code (`comics.router.ts`, `src/pages/comics/**`,
  `src/components/Comics/**`) still uses the legacy `earlyAccessConfig` / `availability==='EarlyAccess'`
  path *by design* — ComicChapter joins PaidAccess in **stage 5**, not this PR.
- `meilisearch/client.test.ts` env-mock line — a **pre-existing `main` bug** fixed in passing (the file is
  byte-identical to `origin/main`; its env mock omitted a var `main` started reading at module load).

## Reviewer path (risk-ordered)

1. **`grantsGeneration` and friends (buzz)** — pure, 16 unit tests. If these are right the callers are
   plumbing. Confirm: `grantsGeneration = isOwnerOrMod || hasBought || (isFreeGeneration || trialLimit>0)`.
2. **`applyPaidAccessGating`** — the paywall. Read `paid-access-gating.test.ts` *first*, then the code.
   Confirm it **demotes** `hasAccess` for a gated non-owner/non-buyer (gated versions are `Public`, so
   resource-data optimistically set `hasAccess=true` — skipping this demotion is exactly how the bypass
   shipped). It's the **only** call site, and it runs inside `getResourceData` post-cache, so all ~15
   `getResourceData` callers inherit it.
3. **`hasEntityAccess`** — the download/read gate. Confirm the parity argument below.
4. **`writePaidAccessForModelVersion`** — the 4-state table in its doc comment, and the reconcile step
   (removing a gate must flip `availability` back to `Public` or non-buyers lock out forever).
5. **`earlyAccessPurchase` + `checkDonationGoalComplete`** — real Buzz moves here. Charge amount can't be
   `undefined` (`assertPaidAccessInput` guards it); the donation-completion call is wrapped in its own
   try/catch so a completion throw can't roll back a committed donation.

## Parity verdict (static review)

Comparing each critical path's pre-refactor version (`origin/main`, which has none of this refactor)
against `HEAD`:

- **`hasEntityAccess` — behavior-preserving.** Old "needs a permission check" set = `{Private,
  EarlyAccess}`. New set = `(not open) OR paidGated`. Because in Phase 1 a PaidAccess row exists **iff**
  `availability='EarlyAccess' & active`, `paidGated ⊆ EarlyAccess`, so the new set collapses to the old
  one. New gates (`Public` + active PaidAccess row) are gated via `paidGated` instead of the enum —
  consistent, and no pre-refactor "old behavior" exists for them to diverge from.
- **Generation gating — behavior-preserving, bug fixed.** The grant matrix (owner / mod / buyer / free /
  trial) reproduces early-access semantics; the demotion ensures non-buyers are correctly denied — which
  is the *true* pre-refactor intent. Enforcement is centralized in the same place (`getResourceData`) as
  the old inline code.
- **No stale ModelVersion gate-checks elsewhere.** A repo sweep found every remaining
  `earlyAccessConfig` / `availability==='EarlyAccess'` reference to be Comics (legacy, stage 5) or a
  comment. Nothing else keys on the enum for ModelVersion access.

**Not provable by static review — verify by testing:** actual Buzz charge amounts, the purchase →
EntityAccess grant, the natural-expiry transition (gate reaches `endsAt` → becomes public, stops
charging), and the donation-goal → early-gate-end path.

## Manual test checklist (for PR testers)

Focus is **model early access + model donation goals**, but cover all of these — early access has *two*
independently-gated surfaces and a full lifecycle, not just "buy it once":

**Early access — generation surface**
- [ ] Non-buyer cannot generate with a paid-generation gated version; sees the paywall.
- [ ] Buyer (after purchase) can generate.
- [ ] Owner and moderator can generate without paying.
- [ ] Free-generation gate: anyone can generate (badge still shows).
- [ ] Trial-limit gate: non-buyer can generate (up to the limit).

**Early access — download surface**
- [ ] Non-buyer cannot download; buyer can; owner/mod can.
- [ ] Charge amount is correct (download price vs generation price).

**Early access — lifecycle**
- [ ] Create a new early-access version → gate applies (both surfaces).
- [ ] Edit the gate (price/timeframe) → change takes effect promptly (cache busts).
- [ ] Remove the gate → version becomes freely accessible again (no permanent lockout).
- [ ] Publish an unpublished timed gate → `endsAt` materializes from publish date.
- [ ] Gate reaches its end date → version becomes public and stops charging.
- [ ] Per-user early-access caps still enforced (`assertUserEarlyAccessLimits`).

**Donation goals**
- [ ] Donate toward a goal → progress updates; a completion error never refunds a committed donation.
- [ ] Goal completes → linked early-access gate **ends early** and the version returns to public.
- [ ] Goal display / amounts render correctly on the model page.

**API consumers (behavior change — intended)**
- [ ] `/api/v1/model-versions/[id]` no longer returns `earlyAccessConfig` / `earlyAccessEndsAt`. Confirm
      nothing you depend on relied on those props.

**No need to test:** Comics/ComicChapter early access (unchanged — not migrated in this phase).

## Migration / deploy notes

- 3 migrations are applied **manually** (never `prisma migrate deploy`).
- Backfill inserts only **active/permanent** gates: prod had 760 `EarlyAccess` versions but 469 active →
  469 PaidAccess rows. The 291 excluded are published-but-expired gates, which both old and new code treat
  identically (permission-check gated), so excluding them changes nothing.
- The catch-up backfill (`paid-access-catchup-backfill.sql`) is re-runnable (`ON CONFLICT DO NOTHING`,
  `WHERE ... IS NULL`) — safe to run twice to catch gates created between deploys.
