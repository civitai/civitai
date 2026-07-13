# Challenge Green/Yellow Buzz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let user-created challenges charge entry fees + prizes in **green** Buzz (safe site) as well as **yellow**, with currency derived per-challenge from the domain at creation and stored immutably.

**Architecture:** Add a single `Challenge.buzzType` (`'green' | 'yellow'`) column, defaulting `'yellow'`. Derive it server-side from `ctx.features.isGreen` at creation (immutable thereafter). Thread the stored `buzzType` through every pool charge/payout so the single-currency pool spends and pays in one currency. Green challenges are enforced SFW on write. Feeds/detail show a challenge only on its matching domain (creator-exempt).

**Tech Stack:** Next.js 14 + TypeScript, tRPC, Prisma (PostgreSQL), Zustand/RHF forms, Mantine v7, Vitest.

## Global Constraints

- **Prisma schema:** NEVER edit `prisma/schema.prisma` (generated). Edit `prisma/schema.full.prisma`, then `pnpm run db:generate`.
- **Migrations are applied MANUALLY** — never `prisma migrate deploy`/`resolve`. Commit the SQL and surface it to the user for preview/staging/prod.
- **buzzType values are exactly `'green' | 'yellow'`** (TEXT column, app-validated). Default `'yellow'`.
- **buzzType is immutable after creation** — edits must never change it; re-derived only at create time.
- **Charge currency is strict single-type** — pass `fromAccountType: buzzType` (no array/fallback), matching bounties.
- **Refund path is UNCHANGED** — `refundUserChallengeFunds` reverses by transaction-id prefix, which preserves currency. Do NOT add a currency arg to it.
- **Participation/entry prizes stay `'blue'`** (system-funded) — out of scope, do not touch.
- **Tests:** Vitest (`pnpm vitest run <path>`). NEVER place tests under `src/pages`.
- Follow existing project comment rules: comment only the non-obvious *why*; no what-narration.

## File Structure

- `prisma/schema.full.prisma` — add `buzzType` to the `Challenge` model.
- `prisma/migrations/<timestamp>_challenge_buzztype/migration.sql` — the `ALTER TABLE` (manual apply).
- `src/server/games/daily-challenge/challenge-currency.ts` — **new** pure module: `deriveDomainCurrency`, `isNonSfwForGreen`, `isChallengeHiddenByDomainCurrency`, `ChallengeBuzzType` type.
- `src/server/games/daily-challenge/challenge-currency.test.ts` — **new** unit tests for the pure module.
- `src/server/games/daily-challenge/challenge-funding.ts` — add `fromAccountType` to `chargeInitialPrize` + `chargeEntryFees`; add `buildWinnerPayoutTransactions` + `getChallengeBuzzType`.
- `src/server/games/daily-challenge/challenge-funding.test.ts` — extend with charge-account-type + payout-builder tests.
- `src/server/games/daily-challenge/challenge-helpers.ts` — add `buzzType` to `ChallengeDetails` type + `getChallengeById` SELECT.
- `src/server/services/challenge.service.ts` — `upsertUserChallenge` (accept + persist buzzType, green guard), `getInfiniteChallenges` (domain filter), `getChallengeDetail` (domain gate).
- `src/server/services/collection.service.ts` — `chargeContestEntryFeesForCollection` reads + passes `buzzType`.
- `src/server/jobs/daily-challenge-processing.ts` — winner payout uses stored buzzType.
- `src/server/routers/challenge.router.ts` — derive/pass `isGreen`/`buzzType` on upsert, getInfinite, getById.
- `src/components/Challenge/ChallengeUpsertForm.tsx` — read-only currency indicator.

---

## Task 1: Data model — `Challenge.buzzType` column + migration

**Files:**
- Modify: `prisma/schema.full.prisma` (Challenge model)
- Create: `prisma/migrations/<timestamp>_challenge_buzztype/migration.sql`
- Generated (do not hand-edit): `prisma/schema.prisma`

**Interfaces:**
- Produces: `Challenge.buzzType: string` (Prisma), default `'yellow'`. Read by Tasks 3–6.

- [ ] **Step 1: Add the field to the full schema**

Find the `Challenge` model in `prisma/schema.full.prisma` and add the field next to `entryFee` (grep for `model Challenge {` and for the `entryFee` line inside it):

```prisma
  buzzType String @default("yellow")
```

- [ ] **Step 2: Regenerate the slim schema + client**

Run: `pnpm run db:generate`
Expected: completes without error; `prisma/schema.prisma` now shows `buzzType String @default("yellow")` on `Challenge`, and the Prisma client type for `Challenge` includes `buzzType: string`.

- [ ] **Step 3: Create the migration SQL**

Run: `pnpm run db:migrate:empty` (creates an empty timestamped migration folder). Then set its `migration.sql` to:

```sql
ALTER TABLE "Challenge" ADD COLUMN "buzzType" TEXT NOT NULL DEFAULT 'yellow';
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.full.prisma prisma/schema.prisma prisma/migrations
git commit -m "feat(challenges): add Challenge.buzzType column (default yellow)"
```

- [ ] **Step 5: Surface the manual migration to the user**

State to the user: the `ALTER TABLE "Challenge" ADD COLUMN "buzzType" ...` must be applied manually (psql/retool) to preview / staging / prod — it will NOT auto-run. The default backfills all existing rows to `'yellow'`.

---

## Task 2: Pure currency module (`challenge-currency.ts`)

Follows the `isChallengeHiddenByPoiCover` pattern in `challenge-visibility.ts`: pure, dependency-light, unit-tested in isolation. Holds every buzzType decision so the service/feed/detail just call it.

**Files:**
- Create: `src/server/games/daily-challenge/challenge-currency.ts`
- Test: `src/server/games/daily-challenge/challenge-currency.test.ts`

**Interfaces:**
- Produces:
  - `type ChallengeBuzzType = 'green' | 'yellow'`
  - `deriveDomainCurrency(isGreen: boolean): ChallengeBuzzType`
  - `isNonSfwForGreen(buzzType: ChallengeBuzzType, allowedNsfwLevel: number): boolean` — true when the pairing is INVALID (green + any non-SFW bit); caller rejects.
  - `isChallengeHiddenByDomainCurrency(challenge: { buzzType: ChallengeBuzzType; createdById: number | null }, isGreen: boolean, viewerId?: number): boolean`
- Consumes: `Flags`, `nsfwBrowsingLevelsFlag` from existing constants.

- [ ] **Step 1: Write the failing test**

Create `src/server/games/daily-challenge/challenge-currency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { nsfwBrowsingLevelsFlag, sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  deriveDomainCurrency,
  isNonSfwForGreen,
  isChallengeHiddenByDomainCurrency,
} from './challenge-currency';

describe('deriveDomainCurrency', () => {
  it('returns green on the green domain', () => {
    expect(deriveDomainCurrency(true)).toBe('green');
  });
  it('returns yellow off the green domain', () => {
    expect(deriveDomainCurrency(false)).toBe('yellow');
  });
});

describe('isNonSfwForGreen', () => {
  it('rejects green + a non-SFW level', () => {
    expect(isNonSfwForGreen('green', nsfwBrowsingLevelsFlag)).toBe(true);
  });
  it('passes green + an SFW-only level', () => {
    expect(isNonSfwForGreen('green', sfwBrowsingLevelsFlag)).toBe(false);
  });
  it('always passes yellow, even with a non-SFW level', () => {
    expect(isNonSfwForGreen('yellow', nsfwBrowsingLevelsFlag)).toBe(false);
  });
});

describe('isChallengeHiddenByDomainCurrency', () => {
  it('hides a yellow challenge on the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ buzzType: 'yellow', createdById: 5 }, true, 99)
    ).toBe(true);
  });
  it('shows a green challenge on the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ buzzType: 'green', createdById: 5 }, true, 99)
    ).toBe(false);
  });
  it('hides a green challenge off the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ buzzType: 'green', createdById: 5 }, false, 99)
    ).toBe(true);
  });
  it('exempts the creator from the domain gate', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ buzzType: 'yellow', createdById: 5 }, true, 5)
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts`
Expected: FAIL — cannot resolve `./challenge-currency`.

- [ ] **Step 3: Write the implementation**

Create `src/server/games/daily-challenge/challenge-currency.ts`:

```typescript
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

export type ChallengeBuzzType = 'green' | 'yellow';

// Domain-derived currency: green site → green Buzz, everything else → yellow. Set once at
// creation and stored on the challenge (immutable) — the winner payout reads it back, so unlike
// bounties the challenge can't reconstruct currency from the ledger.
export function deriveDomainCurrency(isGreen: boolean): ChallengeBuzzType {
  return isGreen ? 'green' : 'yellow';
}

// Green (safe-site) challenges must be SFW. Returns true when the pairing is INVALID — green with
// any non-SFW bit set — so the caller rejects. Yellow always passes. Defense-in-depth: the green
// site's rating selector is already SFW-only.
export function isNonSfwForGreen(
  buzzType: ChallengeBuzzType,
  allowedNsfwLevel: number
): boolean {
  return buzzType === 'green' && Flags.intersects(allowedNsfwLevel, nsfwBrowsingLevelsFlag);
}

// A challenge shows only on the domain matching its currency (green on green, yellow off-green).
// The creator is exempt so they can always reach their own, mirroring the scan/POI gates.
export function isChallengeHiddenByDomainCurrency(
  challenge: { buzzType: ChallengeBuzzType; createdById: number | null },
  isGreen: boolean,
  viewerId?: number
): boolean {
  if (challenge.createdById != null && challenge.createdById === viewerId) return false;
  return challenge.buzzType !== deriveDomainCurrency(isGreen);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-currency.ts src/server/games/daily-challenge/challenge-currency.test.ts
git commit -m "feat(challenges): pure buzzType/domain-currency helpers"
```

---

## Task 3: Charge sites accept `fromAccountType`; add winner-payout builder + buzzType fetch

Extend the funding primitives so pool charges spend the challenge currency, and add a pure payout-transaction builder (testable) plus a lightweight buzzType fetch for the job.

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-funding.ts`
- Test: `src/server/games/daily-challenge/challenge-funding.test.ts`

**Interfaces:**
- Consumes: `ChallengeBuzzType` from `./challenge-currency`; `createBuzzTransaction`/`createBuzzTransactionMany` (already accept `fromAccountType?: BuzzAccountType`).
- Produces:
  - `chargeInitialPrize({ challengeId, userId, amount, fromAccountType })`
  - `chargeEntryFees({ challengeId, userId, imageIds, entryFee, fromAccountType })`
  - `buildWinnerPayoutTransactions({ challengeId, title, buzzType, winners })` → transaction array for `createBuzzTransactionMany`
  - `getChallengeBuzzType(challengeId: number): Promise<ChallengeBuzzType>` (defaults `'yellow'`)

- [ ] **Step 1: Write the failing tests**

Add to `src/server/games/daily-challenge/challenge-funding.test.ts`. First inspect the file's existing mock setup for `~/server/services/buzz.service` and reuse it; append these cases (adapt mock names to the file's existing helpers):

```typescript
import { buildWinnerPayoutTransactions } from './challenge-funding';

describe('buildWinnerPayoutTransactions', () => {
  it('pays winners in the challenge buzzType (green)', () => {
    const txs = buildWinnerPayoutTransactions({
      challengeId: 7,
      title: 'Neon Cats',
      buzzType: 'green',
      winners: [{ userId: 11, position: 1, prize: 5000 }],
    });
    expect(txs).toEqual([
      expect.objectContaining({
        toAccountId: 11,
        fromAccountId: 0,
        amount: 5000,
        toAccountType: 'green',
        externalTransactionId: 'challenge-winner-prize-7-11-place-1',
      }),
    ]);
  });

  it('pays winners in yellow when the challenge is yellow', () => {
    const [tx] = buildWinnerPayoutTransactions({
      challengeId: 7,
      title: 'Neon Cats',
      buzzType: 'yellow',
      winners: [{ userId: 11, position: 1, prize: 5000 }],
    });
    expect(tx.toAccountType).toBe('yellow');
  });
});
```

For the charge-account-type cases, follow the file's existing pattern that mocks `createBuzzTransaction` / `createBuzzTransactionMany` and asserts on their call args. Add:

```typescript
describe('chargeInitialPrize fromAccountType', () => {
  it('forwards fromAccountType to createBuzzTransaction', async () => {
    // (mock createBuzzTransaction per the file's existing setup)
    await chargeInitialPrize({ challengeId: 3, userId: 1, amount: 1000, fromAccountType: 'green' });
    expect(createBuzzTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountType: 'green', amount: 1000 })
    );
  });
});

describe('chargeEntryFees fromAccountType', () => {
  it('forwards fromAccountType to both house and pool legs', async () => {
    // (mock createBuzzTransactionMany to resolve { transactions: [...], conflicts: [] })
    await chargeEntryFees({ challengeId: 3, userId: 1, imageIds: [10], entryFee: 100, fromAccountType: 'green' });
    for (const call of createBuzzTransactionManyMock.mock.calls) {
      expect(call[0][0]).toEqual(expect.objectContaining({ fromAccountType: 'green' }));
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-funding.test.ts`
Expected: FAIL — `buildWinnerPayoutTransactions` not exported; `fromAccountType` not forwarded.

- [ ] **Step 3: Implement in `challenge-funding.ts`**

Add the import near the top:

```typescript
import type { ChallengeBuzzType } from '~/server/games/daily-challenge/challenge-currency';
```

Update `chargeInitialPrize` — add `fromAccountType` to the params and the transaction:

```typescript
export async function chargeInitialPrize({
  challengeId,
  userId,
  amount,
  fromAccountType,
}: {
  challengeId: number;
  userId: number;
  amount: number;
  fromAccountType: ChallengeBuzzType;
}) {
  if (amount <= 0) return;
  await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0,
    fromAccountType,
    type: TransactionType.Purchase,
    amount,
    description: 'Challenge initial prize pool',
    externalTransactionId: `challenge-initial-prize-${challengeId}-creator`,
    details: { challengeId },
  });
  log(`Escrowed ${amount} buzz initial prize for challenge ${challengeId}`);
}
```

Update `chargeEntryFees` — add `fromAccountType` to the params and to BOTH `createBuzzTransactionMany` item shapes (the house-leg map at ~line 119 and the pool-leg map at ~line 147). Add `fromAccountType,` to each mapped object alongside `fromAccountId`:

```typescript
export async function chargeEntryFees({
  challengeId,
  userId,
  imageIds,
  entryFee,
  fromAccountType,
}: {
  challengeId: number;
  userId: number;
  imageIds: number[];
  entryFee: number;
  fromAccountType: ChallengeBuzzType;
}): Promise<ChargeEntryFeesResult> {
  // ...unchanged guards...
  // house-leg items: add `fromAccountType,`
  // pool-leg items:  add `fromAccountType,`
}
```

Add the pure payout builder + the buzzType fetch at the end of the file:

```typescript
/** Build the winner-prize transactions for a challenge, paid in its stored currency. Pure. */
export function buildWinnerPayoutTransactions({
  challengeId,
  title,
  buzzType,
  winners,
}: {
  challengeId: number;
  title: string;
  buzzType: ChallengeBuzzType;
  winners: Array<{ userId: number; position: number; prize: number }>;
}) {
  return winners.map((entry) => ({
    type: TransactionType.Reward,
    toAccountId: entry.userId,
    fromAccountId: 0,
    amount: entry.prize,
    description: `Challenge Winner Prize #${entry.position}: ${title}`,
    externalTransactionId: `challenge-winner-prize-${challengeId}-${entry.userId}-place-${entry.position}`,
    toAccountType: buzzType,
  }));
}

/** The stored pool currency for a challenge; falls back to yellow for legacy/missing rows. */
export async function getChallengeBuzzType(challengeId: number): Promise<ChallengeBuzzType> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { buzzType: true },
  });
  return challenge?.buzzType === 'green' ? 'green' : 'yellow';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-funding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-funding.ts src/server/games/daily-challenge/challenge-funding.test.ts
git commit -m "feat(challenges): thread buzzType through funding charges + payout builder"
```

---

## Task 4: `upsertUserChallenge` — persist buzzType + enforce green→SFW

Derive buzzType server-side in the router, persist it on **create only** (immutable), reject green+non-SFW, and pass the stored currency to the escrow charge.

**Files:**
- Modify: `src/server/services/challenge.service.ts` (`upsertUserChallenge`, ~1245–1470)
- Modify: `src/server/routers/challenge.router.ts` (`upsertUserChallenge` mutation, ~178–183)

**Interfaces:**
- Consumes: `deriveDomainCurrency`, `isNonSfwForGreen`, `ChallengeBuzzType` (Task 2); `chargeInitialPrize` (Task 3).
- Produces: `upsertUserChallenge({ userId, buzzType, ...input })` — new required `buzzType: ChallengeBuzzType` param.

- [ ] **Step 1: Import the helpers in `challenge.service.ts`**

Add to the imports:

```typescript
import {
  deriveDomainCurrency,
  isNonSfwForGreen,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
```

(`deriveDomainCurrency` may be unused in the service if derivation stays in the router — keep only what you reference; the router imports it in Step 4.)

- [ ] **Step 2: Extend the service signature + green guard**

Change the signature (currently `{ userId, ...input }: UserChallengeUpsertInput & { userId: number }`) to also take `buzzType`:

```typescript
export async function upsertUserChallenge({
  userId,
  buzzType,
  ...input
}: UserChallengeUpsertInput & { userId: number; buzzType: ChallengeBuzzType }) {
```

Immediately after `const allowedNsfwLevel = rest.allowedNsfwLevel ?? sfwBrowsingLevelsFlag;` add the guard:

```typescript
  if (isNonSfwForGreen(buzzType, allowedNsfwLevel))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Green challenges must be Safe-For-Work.',
    });
```

- [ ] **Step 3: Persist buzzType on create only (immutable on edit)**

In the `tx.challenge.create({ data: { ...commonData, ... } })` block (the create path, ~line 1447), add `buzzType,` to the `data` object alongside `source: ChallengeSource.User`:

```typescript
    return tx.challenge.create({
      data: {
        ...commonData,
        collectionId: collection.id,
        createdById: userId,
        source: ChallengeSource.User,
        buzzType,
        status: ChallengeStatus.Scheduled,
        // ...unchanged...
      },
    });
```

Do **NOT** add `buzzType` to `commonData` and do **NOT** add it to the edit path's `updateMany` — the edit path must leave buzzType untouched (immutability constraint).

- [ ] **Step 4: Pass buzzType to the escrow charge**

At the `chargeInitialPrize` call (~line 1461) add `fromAccountType: buzzType`:

```typescript
      await chargeInitialPrize({
        challengeId: created.id,
        userId,
        amount: initialPrizeBuzz,
        fromAccountType: buzzType,
      });
```

- [ ] **Step 5: Derive + pass buzzType from the router**

In `src/server/routers/challenge.router.ts`, add the import:

```typescript
import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
```

Change the `upsertUserChallenge` mutation body (~line 183) to derive from the domain and pass it:

```typescript
    .mutation(({ input, ctx }) =>
      upsertUserChallenge({
        ...input,
        userId: ctx.user.id,
        buzzType: deriveDomainCurrency(ctx.features.isGreen),
      })
    ),
```

- [ ] **Step 6: Verify types**

Run: `pnpm run typecheck`
Expected: completes; no errors referencing `buzzType`, `upsertUserChallenge`, or `challenge.router.ts`. (If OOM, re-run — it needs the 8GB heap that `pnpm run typecheck` sets.)

- [ ] **Step 7: Commit**

```bash
git add src/server/services/challenge.service.ts src/server/routers/challenge.router.ts
git commit -m "feat(challenges): derive+persist buzzType on create, enforce green→SFW"
```

---

## Task 5: Entry-fee charge — pass stored buzzType (collection service)

`chargeContestEntryFeesForCollection` charges every accepted entry; it must spend the challenge's stored currency.

**Files:**
- Modify: `src/server/services/collection.service.ts` (`chargeContestEntryFeesForCollection`, ~1909–1934)

**Interfaces:**
- Consumes: `chargeEntryFees({ ..., fromAccountType })` (Task 3); `Challenge.buzzType` column (Task 1).

- [ ] **Step 1: Read buzzType and pass it**

In `chargeContestEntryFeesForCollection`, add `buzzType: true` to the `feeChallenge` select and forward it:

```typescript
  const feeChallenge = await dbRead.challenge.findFirst({
    where: { collectionId, source: 'User', entryFee: { gt: 0 }, status: 'Active' },
    select: { id: true, entryFee: true, buzzType: true },
  });
  if (!feeChallenge) return undefined;
  const { chargeEntryFees } = await import('~/server/games/daily-challenge/challenge-funding');
  return chargeEntryFees({
    challengeId: feeChallenge.id,
    userId,
    imageIds,
    entryFee: feeChallenge.entryFee,
    fromAccountType: feeChallenge.buzzType === 'green' ? 'green' : 'yellow',
  });
```

- [ ] **Step 2: Verify types**

Run: `pnpm run typecheck`
Expected: no errors in `collection.service.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/server/services/collection.service.ts
git commit -m "feat(challenges): charge entry fees in the challenge's stored buzzType"
```

---

## Task 6: Winner payout uses stored buzzType (processing job)

Replace the hardcoded `toAccountType: 'yellow'` with the challenge's stored currency, fetched once before the payout (which runs on both the fresh and retry winner paths).

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` (`pickWinnersForChallenge`, ~1145–1345)

**Interfaces:**
- Consumes: `buildWinnerPayoutTransactions`, `getChallengeBuzzType` (Task 3).

- [ ] **Step 1: Import the helpers**

Ensure these are imported from `~/server/games/daily-challenge/challenge-funding` (the file already imports `refundUserChallengeFunds` from it — extend that import):

```typescript
import {
  refundUserChallengeFunds,
  buildWinnerPayoutTransactions,
  getChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-funding';
```

(Match the file's actual existing import statement for this module; add the two new names to it.)

- [ ] **Step 2: Fetch buzzType once after the claim**

Right after `log('Challenge claimed for completion');` (inside the `try`, before the `existingWinners` branch), add:

```typescript
    const winnerBuzzType = await getChallengeBuzzType(currentChallenge.challengeId);
```

- [ ] **Step 3: Replace the payout transaction construction**

Replace the `createBuzzTransactionMany(winningEntries.map((entry) => ({ ... toAccountType: 'yellow' })))` block (~1328–1341) with the builder:

```typescript
    await withRetries(() =>
      createBuzzTransactionMany(
        buildWinnerPayoutTransactions({
          challengeId: currentChallenge.challengeId,
          title: currentChallenge.title,
          buzzType: winnerBuzzType,
          winners: winningEntries,
        })
      )
    );
    log('Prizes sent');
```

(`winningEntries` items carry `{ userId, imageId, position, prize, reason }`; the builder reads only `userId`/`position`/`prize`, so they pass structurally.)

- [ ] **Step 4: Verify types**

Run: `pnpm run typecheck`
Expected: no errors in `daily-challenge-processing.ts`; the removed `toAccountType: 'yellow'` literal is gone.

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/daily-challenge-processing.ts
git commit -m "feat(challenges): pay winners in the challenge's stored buzzType"
```

---

## Task 7: Feed + detail domain-currency filter

Show a challenge only on the domain matching its currency (creator-exempt on detail). Feed is raw SQL; detail reuses the pure predicate from Task 2.

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts` (`ChallengeDetails` type + `getChallengeById` SELECT)
- Modify: `src/server/services/challenge.service.ts` (`getInfiniteChallenges`, `getChallengeDetail`)
- Modify: `src/server/routers/challenge.router.ts` (`getInfinite`, `getById`)

**Interfaces:**
- Consumes: `isChallengeHiddenByDomainCurrency`, `ChallengeBuzzType` (Task 2); `ctx.features.isGreen`.
- Produces:
  - `getInfiniteChallenges(input & { currentUserId?: number; isGreen?: boolean })`
  - `getChallengeDetail(id, viewerId?, isGreen?)`
  - `ChallengeDetails.buzzType: ChallengeBuzzType`

> **NOTE for reviewer/user:** per spec §5 this filter applies to ALL challenges, so System/daily (yellow) challenges are hidden on the green site and green challenges are hidden off-green. On civitai.com/.red (`isGreen === false`) behavior is unchanged (all existing rows are yellow). Flag this if System challenges should be exempt — that would be a follow-up, not in this plan.

- [ ] **Step 1: Add buzzType to `ChallengeDetails` + `getChallengeById`**

In `challenge-helpers.ts`, add to the `ChallengeDetails` type (near `source: ChallengeSource;`, ~line 91):

```typescript
  buzzType: ChallengeBuzzType;
```

Import the type at the top of the file:

```typescript
import type { ChallengeBuzzType } from '~/server/games/daily-challenge/challenge-currency';
```

Add `c."buzzType",` to the `getChallengeById` SELECT list (next to `c.source,`, ~line 168).

- [ ] **Step 2: Feed filter in `getInfiniteChallenges`**

In `challenge.service.ts`, import the currency helper (if not already):

```typescript
import { isChallengeHiddenByDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
```

Widen the input type and destructure `isGreen`:

```typescript
export async function getInfiniteChallenges(
  input: GetInfiniteChallengesInput & { currentUserId?: number; isGreen?: boolean }
) {
  const {
    // ...existing...
    currentUserId,
    isGreen,
  } = input;
```

After the POI-gate condition push (before the status filter), add the domain-currency condition:

```typescript
  // Domain-currency gate: green challenges only surface on the green site, yellow only off-green.
  const domainCurrency = isGreen ? 'green' : 'yellow';
  conditions.push(Prisma.sql`c."buzzType" = ${domainCurrency}`);
```

- [ ] **Step 3: Detail gate in `getChallengeDetail`**

Change the signature to accept `isGreen`:

```typescript
export async function getChallengeDetail(
  id: number,
  viewerId?: number,
  isGreen?: boolean
): Promise<ChallengeDetail | null> {
```

After the POI-gate block (before `const { _internal, ...detail } = ...`), add:

```typescript
  // Domain-currency gate — direct-URL parity with the feed filter; creator exempt.
  if (
    isChallengeHiddenByDomainCurrency(
      { buzzType: challenge.buzzType, createdById: challenge.createdById },
      isGreen ?? false,
      viewerId
    )
  )
    return null;
```

- [ ] **Step 4: Pass `isGreen` from the router**

In `challenge.router.ts`:

`getInfinite` (~line 79):

```typescript
    .query(({ input, ctx }) =>
      getInfiniteChallenges({ ...input, currentUserId: ctx.user?.id, isGreen: ctx.features.isGreen })
    ),
```

`getById`:

```typescript
    .query(({ input, ctx }) => getChallengeDetail(input.id, ctx.user?.id, ctx.features.isGreen)),
```

- [ ] **Step 5: Verify types**

Run: `pnpm run typecheck`
Expected: no errors; `challenge.buzzType` resolves on the `getChallengeById` result inside `getChallengeDetail`.

- [ ] **Step 6: Run the currency tests again (regression)**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts`
Expected: PASS (unchanged — confirms the predicate the SQL mirrors).

- [ ] **Step 7: Commit**

```bash
git add src/server/games/daily-challenge/challenge-helpers.ts src/server/services/challenge.service.ts src/server/routers/challenge.router.ts
git commit -m "feat(challenges): domain-currency filter on feed + detail (creator-exempt)"
```

---

## Task 8: Form — read-only currency indicator

Show which currency entry fees/prizes use, derived from the domain (no selector). Mirrors the server rule via `useAvailableBuzz()`.

**Files:**
- Modify: `src/components/Challenge/ChallengeUpsertForm.tsx` (Entry Fee & Prizes section, ~673–716)

**Interfaces:**
- Consumes: `useAvailableBuzz()` (`src/components/Buzz/useAvailableBuzz.ts`).

- [ ] **Step 1: Import + derive the domain currency**

Add the import:

```typescript
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
```

Inside the component body (near the other hooks, before the return), derive a display label:

```typescript
  const [domainBuzzType] = useAvailableBuzz();
  const buzzLabel = domainBuzzType === 'green' ? 'Green' : 'Yellow';
```

- [ ] **Step 2: Add the indicator line to the existing Entry Fee alert**

Extend the existing `<Alert>` at ~line 676 (inside the `isUser` block) so it states the currency. Replace its body text with:

```tsx
                <Alert icon={<IconInfoCircle size={16} />} color="blue">
                  Entry fees &amp; prizes use <b>{buzzLabel} Buzz</b>. Your challenge is funded by
                  entry fees — each entry pays the entry fee; {CHALLENGE_ENTRY_HOUSE_CUT} Buzz per
                  entry covers AI judging and the rest grows the prize pool.
                </Alert>
```

- [ ] **Step 3: Verify types**

Run: `pnpm run typecheck`
Expected: no errors in `ChallengeUpsertForm.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/components/Challenge/ChallengeUpsertForm.tsx
git commit -m "feat(challenges): show domain buzz currency in the challenge form"
```

---

## Final verification

- [ ] **Run the full changed-surface unit tests**

Run:
```bash
pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts src/server/games/daily-challenge/challenge-funding.test.ts
```
Expected: PASS.

- [ ] **Typecheck the whole project**

Run: `pnpm run typecheck`
Expected: completes with no errors (confirm it finished — see the 8GB-heap gotcha).

- [ ] **Manual QA checklist (surface to the user)**

  1. On the green site: create a user challenge → stored `buzzType = 'green'`; entry-fee escrow + entries + payout all spend/pay green.
  2. On civitai.com: create → `buzzType = 'yellow'`; unchanged behavior.
  3. Green + a non-SFW `allowedNsfwLevel` → rejected with "Green challenges must be Safe-For-Work."
  4. Green challenge is hidden from the yellow-site feed/detail (and vice-versa); creator can still open their own via direct URL.
  5. Cancel a green challenge → pool refunds land back in green (prefix-reversal preserves currency — no code change).

- [ ] **Remind the user** the `ALTER TABLE` from Task 1 must be applied manually to each environment.

---

## Self-review notes (author)

- **Spec coverage:** §1 → Task 1; §2 → Task 4 (router derive + service persist, immutable, create-only); §3 charge sites A/B → Tasks 3+5, C payout → Task 6, F refund → intentionally NO CHANGE (Global Constraints), D participation → untouched; §4 green→SFW pure helper → Task 2 + guard in Task 4; §5 feed+detail → Task 7; §6 form indicator → Task 8; §7 tests → Tasks 2/3 + Final.
- **Immutability:** buzzType is set only in the create `data`; the edit path (`updateMany` with `commonData`) never references it. ✔
- **Payout runs on both winner paths** (existing-winners reuse + fresh) → buzzType fetched before the branch, not from the else-only `challengeJudgeRow`. ✔
- **Type consistency:** `ChallengeBuzzType = 'green' | 'yellow'` used across currency/funding/helpers/service; `fromAccountType`/`toAccountType` are the real buzz-service param names (`buzz.service.ts:310,454`). ✔
