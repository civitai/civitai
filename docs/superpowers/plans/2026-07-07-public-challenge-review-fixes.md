# Public Challenge PR #2965 — Review-Fix Plan

> Executed via subagent-driven-development. Fixes the verified findings from the 4-area PR review. Money cluster (F1–F3) first + reviewed; feature is dark so all are latent/launch-blockers.

**Base:** current HEAD of `feat/public-challenges` (after form-parity work).

## Global constraints
- Buzz never minted: pool/refunds must derive from **actual charge transactions**, not CollectionItem rows. Account 0 has no balance floor, so an inflated pool is real minted Buzz.
- Idempotency keys: entry fee `challenge-entry-fee-${challengeId}-${imageId}`, initial prize `challenge-initial-prize-${challengeId}`, entry refund `challenge-entry-refund-${challengeId}-${imageId}`, initial refund `challenge-initial-refund-${challengeId}`.
- Only touch User-source behavior; daily/mod/system judging + funding paths unchanged.
- `judgingCategories`/`entryFee`/`scanStatus`/`scannedAt` are readable via Prisma client (confirmed in the real generated schema) AND via raw SQL — use whichever the surrounding code uses.
- NSFW challenges are now ALLOWED (product decision) — do NOT clamp `allowedNsfwLevel`; instead surface the control.

---

### F1 — Entry-fee refunds/charges reverse only ACTUAL money (fixes #2 mint, #3 stranded, I2)
**File:** `src/server/games/daily-challenge/challenge-funding.ts`; verify input shape in `src/server/schema/buzz.schema.ts` (`refundMultiAccountTransactionInput`, ~255-296) + `refundMultiAccountTransaction`/`refundTransaction` in `buzz.service.ts`.

- **#2 (cancel refund mint):** replace the `refundUserChallengeFunds` entry-refund loop (iterates every CollectionItem, mints for unpaid) with `refundMultiAccountTransaction({ externalTransactionIdPrefix: `challenge-entry-fee-${challengeId}-`, ... })` — reverses exactly the collected fee charges, so unpaid entries can't be refunded. Refund the initial prize by reversing the actual `challenge-initial-prize-${challengeId}` charge (prefix or `getTransactionByExternalId`→`refundTransaction`) instead of a fresh credit. Confirm the input needs (fromAccountId/type/description) from the schema and mirror the bounty usage in `bounty.service.ts:526`.
- **#3 (partial charge strands Buzz):** in `chargeEntryFees`, when `settled < imageIds.length`, refund the partial successes before throwing — `result.transactions` are transaction ids; `for (const id of result.transactions) await refundTransaction(id, 'Challenge entry — partial charge reversed')` then throw the insufficient-funds error. No stranded Buzz.
- **I2:** fix the now-inaccurate "Idempotent" doc comments; the prefix-refund path is safely re-runnable.

**Verify:** `pnpm run typecheck`. Commit: `fix(public-challenges): reverse only real entry-fee/prize charges (no mint, no stranded partial)`.

---

### F2 — Prize pool at completion uses REAL collected amount, not entry count (fixes #1 mint)
**File:** `src/server/jobs/daily-challenge-processing.ts` (pool recompute ~1016-1055); read `computeDynamicPool` in `challenge-pool.ts` first.

`prizePool` already accumulates the real collected pool (seeded to `basePrizePool` at create; `chargeEntryFees` increments it by net contributions of only *charged* entries). The bug: the completion recompute OVERWRITES it with `basePrizePool + buzzPerAction * COUNT(ACCEPTED CollectionItems)`, counting unpaid/mod-added entries.

- For `source === User`: do NOT recompute the total from the ACCEPTED count. Use the already-accumulated `prizePool` (select it) as `totalPool`, and compute the `prizes` breakdown from that `totalPool` + `prizeDistribution` (reuse `computeDynamicPool`'s distribution logic, or a distribution-only helper, passing the real total). Daily/mod/system path unchanged (still count-based — those have no entry fees).

**Verify:** `pnpm run typecheck`. Commit: `fix(public-challenges): fund user prize pool from real collections, not entry count`.

---

### F3 — Refund the residual pool when a paid user challenge ends with no winners (Important)
**Files:** `src/server/jobs/daily-challenge-processing.ts` (`pickWinnersForChallenge` completion) + `src/server/services/challenge.service.ts` (`endChallengeAndPickWinners`).

When `getJudgedEntries` is empty (all theme-disqualified / cooldown-filtered / 0 entries) for a `source=User`, entry-fee challenge, the challenge is marked Completed with NO payout and NO refund → collected Buzz stranded in account 0. Fix: on the zero-winner completion path for User source, refund the collected entry fees + initial prize (reuse the F1 prefix-refund via `refundUserChallengeFunds`, which is now mint-safe). Scope to ZERO winners; log the partial-winner (fewer than distribution places) remainder as a follow-up (product decision on pro-rata) — do not implement pro-rata now.

**Verify:** `pnpm run typecheck`. Commit: `fix(public-challenges): refund pool when a paid user challenge ends with no winners`.

---

### F4 — Scan gate on detail read + activation; auto-void Blocked (fixes #5 leak)
**Files:** `src/server/services/challenge.service.ts` (`getChallengeDetail` ~756), `src/server/games/daily-challenge/challenge-helpers.ts` (`getChallengeById` select + `getScheduledChallengesReadyToStart` ~238), `src/server/jobs/daily-challenge-processing.ts` (`startScheduledChallenge` ~1327), router `getById` handler.

- `getChallengeById` SELECT must include `scanStatus` (+ `source`, `createdById`, and the 5 new cols while here — see F6).
- `getChallengeDetail(id, viewerId?)`: after the existing `visibleAt`/`Cancelled` checks, return null when `source===User && scanStatus!=='Scanned' && createdById!==viewerId`. Thread `viewerId` from the `getById` router handler (`ctx.user?.id`), passed as optional (public/SSR may be anonymous).
- Activation: `getScheduledChallengesReadyToStart` must exclude `source=User` challenges whose `scanStatus!=='Scanned'`. A `source=User` challenge that is `Blocked` should be auto-voided + refunded (reuse `voidChallenge`) rather than sitting Scheduled forever — do this in the activation job when it encounters a Blocked user challenge past its start.

**Verify:** `pnpm run typecheck`. Commit: `fix(public-challenges): gate user-challenge detail + activation on scan status`.

---

### F5 — Let users choose the browsing level (NSFW allowed) (#4 reframed)
**File:** `src/components/Challenge/ChallengeUpsertForm.tsx`.

NSFW user challenges are allowed. For the `variant==='user'` path: STOP forcing `allowedNsfwLevel = sfwBrowsingLevelsFlag`, and RENDER the existing `InputContentRatingSelect` (currently gated `!isUser`) for users too, defaulting to SFW but user-selectable. Update the entry-fee Alert copy that implies SFW-only if present. Server schema already accepts 1-63 — no server change.

**Verify:** `pnpm run typecheck`. Commit: `feat(public-challenges): allow users to pick the challenge browsing level (NSFW)`.

---

### F6 — Null-safe deleted-creator (Important)
**Files:** `src/server/games/daily-challenge/challenge-helpers.ts` (`ChallengeDetails` type + `getChallengeById`), `src/server/services/challenge.service.ts` (`buildChallengeDetail`).

`Challenge.createdById` is nullable (ON DELETE SET NULL) but `ChallengeDetails.createdById` is typed `number` with no guard → deleted creator makes `WHERE id = NULL` and silently drops `createdBy.id/username`. Fix: type `createdById: number | null`; in `buildChallengeDetail` fall back to the system user (`?? -1`, matching the pattern already at `challenge.service.ts:2217`) before the creator lookup + `getProfilePicturesForUsers`/`getCosmeticsForUsers`. (Fold the F4 `getChallengeById` SELECT additions here.)

**Verify:** `pnpm run typecheck`. Commit: `fix(public-challenges): handle deleted challenge creator (null createdById)`.

---

### F7 — Minors
**Files:** `src/server/schema/challenge.schema.ts`, `src/server/services/challenge.service.ts`.

- **Case-insensitive category label uniqueness:** in `challengeJudgingCategoriesSchema.superRefine`, reject two categories whose `sanitizeCategoryLabel(label).toLowerCase()` collide (a custom "Humor" shadowing preset Humor, "Color"/"color"). Add a test case.
- **Orphan cover Image:** in `upsertUserChallenge`, move the `createImage` cover creation to AFTER `assertCanCreateUserChallenge` so an ineligible caller doesn't leave an orphan Image.
- **Skip:** paid-then-removed forfeit (product decision), judge-prompt prose eval (manual), migration `CONCURRENTLY`/FK-name (already-committed migration; surface as ops note, don't rewrite).

**Verify:** `pnpm run typecheck` + `pnpm vitest run src/server/schema/__tests__/challenge-category.schema.test.ts`. Commit: `fix(public-challenges): case-insensitive category labels + avoid orphan cover image`.

---

### F8 — Verification
- `pnpm run typecheck` → 0 source errors.
- `pnpm vitest run src/server/schema/__tests__/challenge-category.schema.test.ts src/server/games/daily-challenge/daily-challenge-scoring.test.ts` → pass.
- Whole-branch re-review of the fix commits (opus).
