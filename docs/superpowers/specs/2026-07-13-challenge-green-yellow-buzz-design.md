# Challenge Green/Yellow Buzz — Design Spec

**Date:** 2026-07-13
**Branch:** `feat/public-challenges`
**Status:** Approved design, ready for implementation planning

## Goal

Let user-created challenges charge entry fees + prizes in **green** Buzz (safe site / civitai.green)
as well as **yellow** (civitai.com / civitai.red), copying how bounties handle it. Motivation
(Justin): more uses for green Buzz; let safe-site users participate; green isn't spendable on
civitai.red anyway.

Currency is **per-challenge, single-currency, domain-derived** — not a user choice.

## Background: how bounties do it (reference)

- `buzzType: z.enum(['green','yellow'])` — input only, **not persisted** on any bounty model
  (`src/server/schema/bounty.schema.ts:86`).
- Charges deduct via `fromAccountTypes: [buzzType]` → account `0`
  (`bounty.service.ts:259`, `:662`).
- buzzType is **domain-derived**, not user-selected: `ctx.features.isGreen ? 'green' : 'yellow'`
  (`bounty.controller.ts:445`). The bounty form has **no selector** — `useAvailableBuzz()` returns
  one type per domain (`src/components/Buzz/useAvailableBuzz.ts`).
- Green rules: reject NSFW (`bounty.service.ts:190`), lock `nsfw` field via `lockedProperties`
  (`:205`).
- Payout/refund reconstruct currency **from the ledger** (transaction-id prefix), so bounties don't
  need to store buzzType (`prepare-bounties.ts:343-423`).

**Why challenges differ:** the challenge winner payout **hardcodes `toAccountType: 'yellow'`**
(`src/server/jobs/daily-challenge-processing.ts:1339`) and never reads the ledger. So challenges
**must store** `buzzType` (single-currency pool) — the payout reads it.

`Challenge` records no currency today — all amounts are `Int` (`prisma/schema.prisma:4794-4875`).

## Design

### 1. Data model (migration — MANUAL APPLY)

```sql
ALTER TABLE "Challenge" ADD COLUMN "buzzType" TEXT NOT NULL DEFAULT 'yellow';
```

- Text column, values `'green' | 'yellow'`, app-validated. Default `'yellow'` backfills all existing
  rows (all currently yellow).
- **No `lockedProperties` column** — buzzType is immutable after creation and re-enforced on every
  write, so there's nothing to lock (unlike bounties/articles).
- Edit `prisma/schema.full.prisma` (NOT `schema.prisma` — it's generated), then
  `pnpm run db:generate`. Migrations are applied **manually** (never `prisma migrate deploy`) — surface
  the SQL to the user for preview/staging/prod.

### 2. buzzType derivation — server-authoritative, domain-derived

- Set once at creation: `buzzType = ctx.features.isGreen ? 'green' : 'yellow'`
  (helper: `getAllowedAccountTypes(features)` in `src/server/utils/buzz-helpers.ts:72`).
- Derived in the challenge upsert **controller** feeding `upsertUserChallenge`; the service ignores
  any client-sent buzzType.
- **Immutable** — edits never change it (a challenge can't change domain/currency).

### 3. Money-charge sites — thread `challenge.buzzType`

Single-currency pool. All pool-related charges read the stored buzzType:

| Site | Location | Change |
|---|---|---|
| A. Initial-prize escrow | `chargeInitialPrize`, `src/server/games/daily-challenge/challenge-funding.ts:65` | add `fromAccountType: buzzType` (plumb from `challenge.service.ts:1461`) |
| B. Entry fee — house leg | `chargeEntryFees`, `challenge-funding.ts:118` | add `fromAccountType: buzzType` |
| B. Entry fee — pool leg | `chargeEntryFees`, `challenge-funding.ts:146` | add `fromAccountType: buzzType` |
| — plumbing for B | `chargeContestEntryFeesForCollection`, `src/server/services/collection.service.ts:1927` | read + pass `challenge.buzzType` |
| C. Winner payout | `src/server/jobs/daily-challenge-processing.ts:1339` | replace hardcoded `toAccountType: 'yellow'` → `challenge.buzzType` |
| F. Refund | `refundUserChallengeFunds`, `challenge-funding.ts:245` | **NO CHANGE** — prefix-reversal preserves currency |
| D. Participation prizes | `daily-challenge-processing.ts:1026`, `challenge-rewards.ts:107`, `challenge-prize.ts:70` | **NO CHANGE** — system-funded `'blue'`, not the pool |

- `createBuzzTransaction` / `createBuzzTransactionMany` accept `fromAccountType`
  (`src/server/schema/buzz.schema.ts:86`) — strict single type (no fallback), matching bounties.
- Pool amount stays a single `Challenge.prizePool` Int; only the currency label moves.

### 4. Green → SFW (enforce-on-write, no lock column)

- In `upsertUserChallenge`, when `buzzType === 'green'` and `allowedNsfwLevel` includes any
  non-SFW bit: **reject** (throw `BAD_REQUEST`, "Green challenges must be Safe-For-Work"), mirroring
  the bounty green+NSFW guard (`bounty.service.ts:190`). Defense-in-depth — the green/SFW site's
  rating selector is already SFW-only, so this is a safety net, not the primary UX.
- Re-enforced on every write; buzzType can't change, so no lock needed.
- Composes with the in-flight scan work: a green challenge is SFW-bounded, so the text scan can't
  raise it to R (it stays within SFW).
- Extract the clamp/guard decision into a **pure, unit-tested helper** (pattern:
  `isChallengeHiddenByPoiCover` in `src/server/games/daily-challenge/challenge-visibility.ts`).

### 5. Feed + detail domain-currency filter

Decision: **green challenges only on the green site; yellow only on non-green.**

- `getInfiniteChallenges` (`src/server/services/challenge.service.ts`) — router passes
  `features.isGreen` (currently passes only `currentUserId`, `challenge.router.ts:79`); add WHERE
  `c."buzzType" = ${domainCurrency}` where `domainCurrency = isGreen ? 'green' : 'yellow'`.
- `getChallengeDetail` — same domain-currency gate for direct-URL parity, **creator-exempt** like the
  existing scan gate and POI gate (`challenge.service.ts` ~`getChallengeDetail`).

### 6. Form — indicator only (no selector)

- No buzz-type control. Add a **read-only indicator** in the "Entry Fee & Prizes" section of
  `src/components/Challenge/ChallengeUpsertForm.tsx` showing the currency (reuse
  `BuzzEnvironmentAlert` / currency icons): "Entry fees & prizes use Green/Yellow Buzz."
- Entry-fee / prize `InputNumber`s already render a Buzz icon; make it reflect the domain currency.
- Client mirrors the domain rule via `useAvailableBuzz()`.

### 7. Testing

- **Pure green→SFW clamp helper** — unit test (SFW clamp when green, passthrough when yellow).
- **Charge account types** — mock buzz service; assert `chargeEntryFees` (house + pool) and
  `chargeInitialPrize` pass the challenge's `fromAccountType`.
- **Payout** — assert `toAccountType` = `challenge.buzzType`, not hardcoded yellow.
- **Feed/detail domain-currency filter** — predicate-level test (green hidden on non-green, etc.).
- Vitest: `pnpm vitest run <path>`. Never place tests under `src/pages`.

## Out of scope / deferred

- No rating-review / dispute flow (explicitly dropped — bounty-lean, no new mod queue).
- No `lockedProperties` column.
- Participation/entry prizes stay `'blue'` (system-funded).
- Green-buzz balance top-up UX unchanged (existing Buzz components handle it).

## Related in-flight work (same branch, not part of this spec)

Already implemented this session on `feat/public-challenges` (uncommitted working tree):
- Challenge form fixes (invitation gating, judging-categories/visibleAt validation, required-field
  asterisks, description required, alert relocation).
- Article-style text moderation scan for challenges (`challenge-moderation.adapter.ts`,
  `scanUserChallenge` → async XGuard, raise-to-R / block).
- POI cover gate + no-cover feed filter + `challenge-visibility.ts` (`isChallengeHiddenByPoiCover`).

Planning should treat these as existing context, not re-implement them.

## Migration checklist (for the user)

1. Add `buzzType` to `prisma/schema.full.prisma` on `Challenge`; `pnpm run db:generate`.
2. Commit the migration SQL under `prisma/migrations/`.
3. Apply the `ALTER TABLE` manually to preview / staging / prod (psql/retool) — NOT via
   `prisma migrate deploy`.
