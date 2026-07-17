# Challenge NSFW Scan Escalation & Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user challenge's text scans as sexual content, escalate its rating to R and flip a green (safe-site) challenge to yellow so the domain-currency gate moves it off civitai.com onto civitai.red — refunding the green initial prize so the pool currency stays consistent.

**Architecture:** Broaden the challenge text scan to `nsfw+suggestive+explicit`. A pure decision function (`computeNsfwEscalation`) decides the new levels / flip / refund; a thin IO helper (`applyChallengeNsfwEscalation`) applies it (challenge row, collection `forcedBrowsingLevel`, green-prize refund, notification). The moderation adapter's `applyResult` delegates to the helper. Separately, currency-scope the initial-prize `externalTransactionId` to prevent a silent-drop unfunded-pool bug on any future re-charge.

**Tech Stack:** TypeScript, Prisma, Vitest, tRPC (Civitai monorepo). Test runner: `pnpm vitest run <path>`.

## Global Constraints

- Test runner is **Vitest**, not Jest. Run a single file with `pnpm vitest run <path>`.
- `green` and `yellow` are **distinct buzz wallets** — flipping `buzzType` requires the pool currency to match (never pay winners a currency never collected).
- `NsfwLevel.R = 4` (`~/server/common/enums`, numeric bitwise enum). `allowedNsfwLevel` is a bitwise browsing-level mask. `deriveChallengeNsfwLevel(mask) = Flags.maxValue(mask) || NsfwLevel.PG`.
- The scan callback runs on a **Scheduled, no-entries** challenge (the callback is what sets `Scanned`; entries need Active+visible). The only escrow at flip time is the creator's optional initial prize, charged in green.
- Do NOT change global XGuard thresholds. Detection change is per-request labels only.
- No schema change, no manual DB migration.
- Prettier runs automatically — do not run it manually.

---

## File Structure

- **Modify** `src/server/games/daily-challenge/challenge-funding.ts` — currency-scope the initial-prize `externalTransactionId`.
- **Modify** `src/server/games/daily-challenge/challenge-helpers.ts` — add `CHALLENGE_MODERATION_LABELS` const.
- **Modify** `src/server/games/daily-challenge/challenge-currency.ts` — add pure `computeNsfwEscalation`.
- **Create** `src/server/games/daily-challenge/challenge-nsfw-escalation.ts` — IO helper `applyChallengeNsfwEscalation`.
- **Modify** `src/server/services/challenge-moderation.adapter.ts` — scan labels + delegate `applyResult` to the helper.
- **Modify** `src/server/services/challenge.service.ts` — `scanUserChallenge` uses the shared label const.
- **Create** `src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts` — helper tests.
- **Modify** existing tests: `challenge-funding.test.ts`, `challenge-currency.test.ts`.

---

## Task 1: Currency-scope the initial-prize externalTransactionId

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-funding.ts:77`
- Test: `src/server/games/daily-challenge/challenge-funding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: charge `externalTransactionId` format `challenge-initial-prize-${challengeId}-creator-${fromAccountType}`. The refund prefix `challenge-initial-prize-${challengeId}-creator` (used by `refundUserChallengeFunds`) remains a valid prefix of both the old (`-creator`) and new (`-creator-green`/`-creator-yellow`) ids — later tasks refund the flip with the explicit `-creator-green` prefix.

- [ ] **Step 1: Write the failing test**

Add to `src/server/games/daily-challenge/challenge-funding.test.ts` (inside the existing `chargeInitialPrize` describe block, or a new one if none):

```ts
describe('chargeInitialPrize externalTransactionId', () => {
  beforeEach(() => {
    mockCreateBuzzTransaction.mockReset();
    mockCreateBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
  });

  it('scopes the externalTransactionId by currency (green)', async () => {
    await chargeInitialPrize({ challengeId: 42, userId: 7, amount: 100, fromAccountType: 'green' });
    const [arg] = mockCreateBuzzTransaction.mock.calls[0];
    expect(arg.externalTransactionId).toBe('challenge-initial-prize-42-creator-green');
  });

  it('scopes the externalTransactionId by currency (yellow)', async () => {
    await chargeInitialPrize({ challengeId: 42, userId: 7, amount: 100, fromAccountType: 'yellow' });
    const [arg] = mockCreateBuzzTransaction.mock.calls[0];
    expect(arg.externalTransactionId).toBe('challenge-initial-prize-42-creator-yellow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-funding.test.ts -t "scopes the externalTransactionId"`
Expected: FAIL — actual id is `challenge-initial-prize-42-creator` (no currency suffix).

- [ ] **Step 3: Implement the change**

In `src/server/games/daily-challenge/challenge-funding.ts`, in `chargeInitialPrize`, change the `externalTransactionId` (currently line 77). Replace:

```ts
    // Trailing non-numeric token keeps the completion refund's startsWith prefix match unambiguous
    // vs other challenge ids (challenge 5 would otherwise prefix-match 50, 51, ...).
    externalTransactionId: `challenge-initial-prize-${challengeId}-creator`,
```

with:

```ts
    // Trailing `-creator` keeps prefix matches unambiguous vs other challenge ids (challenge 5 would
    // otherwise prefix-match 50, 51, ...). The currency suffix scopes the id per wallet: a refunded
    // green charge leaves its id occupied in the ledger, so a later yellow re-charge on a shared id
    // would be silently dropped (createBuzzTransaction dedups on externalTransactionId) — leaving an
    // unfunded pool. `-creator` prefix matchers still match both `-creator-green` and `-creator-yellow`.
    externalTransactionId: `challenge-initial-prize-${challengeId}-creator-${fromAccountType}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-funding.test.ts`
Expected: PASS (all tests in the file, including the existing refund/prefix tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-funding.ts src/server/games/daily-challenge/challenge-funding.test.ts
git commit -m "fix(challenge): currency-scope initial-prize externalTransactionId

Refunding a charge leaves its externalTransactionId occupied in the ledger, so a
later yellow re-charge on the shared green id would be silently dropped by the
createBuzzTransaction dedup, leaving an unfunded pool. Suffix the id with the
currency; the -creator prefix matchers still match both variants.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Broaden challenge scan labels (detection)

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-helpers.ts` (add const near `buildChallengeModerationText`)
- Modify: `src/server/services/challenge-moderation.adapter.ts:43`
- Modify: `src/server/services/challenge.service.ts:1754`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CHALLENGE_MODERATION_LABELS = ['nsfw', 'suggestive', 'explicit'] as const;` from `challenge-helpers.ts`. Both scan call sites request this set. A triggered scan now returns `triggeredLabels` containing any of `NSFW` / `Suggestive` / `Explicit`.

- [ ] **Step 1: Add the shared label constant**

In `src/server/games/daily-challenge/challenge-helpers.ts`, directly above `export function buildChallengeModerationText(` (currently line 38), add:

```ts
// Labels requested for the challenge text scan. `nsfw` alone (threshold 0.75) misses crude sexual
// themes that score below it; `suggestive` and `explicit` (threshold 0.5) catch sexually-charged
// text on a green/SFW challenge with a large margin. Any triggered label escalates the challenge.
export const CHALLENGE_MODERATION_LABELS = ['nsfw', 'suggestive', 'explicit'] as const;
```

- [ ] **Step 2: Wire the adapter submit call**

In `src/server/services/challenge-moderation.adapter.ts`:

Add to the import from `challenge-helpers` (currently line 6, `import { buildChallengeModerationText } from '~/server/games/daily-challenge/challenge-helpers';`):

```ts
import {
  buildChallengeModerationText,
  CHALLENGE_MODERATION_LABELS,
} from '~/server/games/daily-challenge/challenge-helpers';
```

Then in the `submit` function replace `labels: ['nsfw'],` (line 43) with:

```ts
      labels: [...CHALLENGE_MODERATION_LABELS],
```

- [ ] **Step 3: Wire the scanUserChallenge call**

In `src/server/services/challenge.service.ts`, `scanUserChallenge` (the `submitTextModeration` call around line 1754), replace `labels: ['nsfw'],` with:

```ts
      labels: [...CHALLENGE_MODERATION_LABELS],
```

Add `CHALLENGE_MODERATION_LABELS` to the existing import from `~/server/games/daily-challenge/challenge-helpers` in that file. Verify the import exists first:

Run: `grep -n "from '~/server/games/daily-challenge/challenge-helpers'" src/server/services/challenge.service.ts`

If `buildChallengeModerationText` is already imported from that module, add `CHALLENGE_MODERATION_LABELS` to that import block. If there is no import from that module, add:

```ts
import { CHALLENGE_MODERATION_LABELS } from '~/server/games/daily-challenge/challenge-helpers';
```

- [ ] **Step 4: Typecheck the touched files compile**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-helpers.test.ts`
Expected: PASS (existing helper tests still pass; the new export doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-helpers.ts src/server/services/challenge-moderation.adapter.ts src/server/services/challenge.service.ts
git commit -m "feat(challenge): scan text for suggestive+explicit, not nsfw only

The nsfw label (threshold 0.75) misses crude sexual themes; suggestive/explicit
(threshold 0.5) catch them with a large margin. Centralize the label set so the
adapter submit and scanUserChallenge stay in sync.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure escalation decision (`computeNsfwEscalation`)

**Files:**
- Modify: `src/server/games/daily-challenge/challenge-currency.ts`
- Test: `src/server/games/daily-challenge/challenge-currency.test.ts`

**Interfaces:**
- Consumes: `deriveChallengeNsfwLevel` (from `daily-challenge.utils`), `NsfwLevel` (from `~/server/common/enums`), `Flags`, `ChallengeSource`, `ChallengeBuzzType` (already in this file).
- Produces:
  ```ts
  export type NsfwEscalation = {
    allowedNsfwLevel: number;      // possibly raised (R bit added)
    nsfwLevel: number;             // display level derived from allowedNsfwLevel
    flip: boolean;                 // buzzType green -> yellow
    refundInitialPrize: boolean;   // refund the green initial prize + zero the pool
  };
  export function computeNsfwEscalation(input: {
    allowedNsfwLevel: number;
    buzzType: ChallengeBuzzType;
    source: ChallengeSource;
    basePrizePool: number;
    isNsfw: boolean;
  }): NsfwEscalation;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/server/games/daily-challenge/challenge-currency.test.ts`. Extend the import from `./challenge-currency` to include `computeNsfwEscalation`, and add `NsfwLevel` import. Add this describe block:

```ts
import { NsfwLevel } from '~/server/common/enums';

describe('computeNsfwEscalation', () => {
  const PG_PG13 = NsfwLevel.PG | NsfwLevel.PG13; // 3, SFW mask

  it('no-ops on a clean scan (nsfwLevel = derived base, no flip/refund)', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: false,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13);
    expect(r.nsfwLevel).toBe(NsfwLevel.PG13); // maxValue(PG|PG13)
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('green user challenge + nsfw: raises to R, flips, refunds when a prize exists', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R); // 7
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
    expect(r.flip).toBe(true);
    expect(r.refundInitialPrize).toBe(true);
  });

  it('green user challenge + nsfw with no prize: flips but no refund', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 0,
      isNsfw: true,
    });
    expect(r.flip).toBe(true);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('yellow user challenge + nsfw: raises to R but does not flip or refund', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'yellow',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R);
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('non-user (System) challenge + nsfw: raises to R, never flips', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.System,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts -t "computeNsfwEscalation"`
Expected: FAIL with "computeNsfwEscalation is not a function" / import error.

- [ ] **Step 3: Implement `computeNsfwEscalation`**

In `src/server/games/daily-challenge/challenge-currency.ts`, add imports at the top (the file already imports `Flags` and `ChallengeSource`):

```ts
import { NsfwLevel } from '~/server/common/enums';
import { deriveChallengeNsfwLevel } from '~/server/games/daily-challenge/daily-challenge.utils';
```

Append at the end of the file:

```ts
export type NsfwEscalation = {
  allowedNsfwLevel: number;
  nsfwLevel: number;
  flip: boolean;
  refundInitialPrize: boolean;
};

// Decide how a scanned challenge escalates. Clean scans recompute the display level from the
// (unchanged) allowed mask. An NSFW scan adds the R bit so the challenge drops out of safe feeds;
// a green USER challenge additionally flips to yellow (the domain-currency gate then moves it off
// the safe site) and refunds its green initial prize so the pool currency matches the new buzzType.
export function computeNsfwEscalation(input: {
  allowedNsfwLevel: number;
  buzzType: ChallengeBuzzType;
  source: ChallengeSource;
  basePrizePool: number;
  isNsfw: boolean;
}): NsfwEscalation {
  if (!input.isNsfw) {
    return {
      allowedNsfwLevel: input.allowedNsfwLevel,
      nsfwLevel: deriveChallengeNsfwLevel(input.allowedNsfwLevel),
      flip: false,
      refundInitialPrize: false,
    };
  }
  const allowedNsfwLevel = Flags.addFlag(input.allowedNsfwLevel, NsfwLevel.R);
  const flip = input.source === ChallengeSource.User && input.buzzType === 'green';
  return {
    allowedNsfwLevel,
    nsfwLevel: deriveChallengeNsfwLevel(allowedNsfwLevel),
    flip,
    refundInitialPrize: flip && input.basePrizePool > 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-currency.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-currency.ts src/server/games/daily-challenge/challenge-currency.test.ts
git commit -m "feat(challenge): add computeNsfwEscalation pure decision

Given a scanned challenge, decides the raised allowed/display nsfw levels and
whether a green user challenge flips to yellow + refunds its green initial prize.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: IO escalation helper (`applyChallengeNsfwEscalation`)

**Files:**
- Create: `src/server/games/daily-challenge/challenge-nsfw-escalation.ts`
- Test: `src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts`

**Interfaces:**
- Consumes: `computeNsfwEscalation`, `NsfwEscalation` (Task 3); `refundMultiAccountTransaction` (`~/server/services/buzz.service`); `createNotification` (`~/server/services/notification.service`); `dbRead`/`dbWrite`; `CollectionMetadataSchema` (`~/server/schema/collection.schema`); `NotificationCategory` (`~/server/common/enums`); `ChallengeIngestionStatus`, `ChallengeSource` (`~/shared/utils/prisma/enums`); `ChallengeBuzzType` (`~/server/games/daily-challenge/challenge-currency`).
- Produces: `export async function applyChallengeNsfwEscalation(args: { entityId: number; isNsfw: boolean }): Promise<void>;` — reads the challenge, applies the escalation (challenge row, collection `forcedBrowsingLevel`, refund, notification). Idempotent (flip gated on stored `buzzType === 'green'`). Task 5's adapter calls this.

**Ordering invariant (crash-safety):** refund the green prize BEFORE writing the challenge update. `refundMultiAccountTransaction` is idempotent (it won't re-reverse an already-refunded charge). So if the update crashes after a successful refund, the retry re-reads a still-green row, re-attempts the (no-op) refund, then completes the update. If we flipped first and then the refund crashed, the retry would see `yellow`, skip the refund, and strand the green charge.

- [ ] **Step 1: Write the failing test**

Create `src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockRefundMultiAccountTransaction,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockDbRead: {
    challenge: { findUnique: vi.fn() },
    collection: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    challenge: { update: vi.fn() },
    collection: { update: vi.fn() },
  },
  mockRefundMultiAccountTransaction: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/buzz.service', () => ({
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { applyChallengeNsfwEscalation } = await import('./challenge-nsfw-escalation');

const PG_PG13 = 3; // NsfwLevel.PG | NsfwLevel.PG13
const R = 4;

function greenChallenge(overrides: Record<string, unknown> = {}) {
  return {
    allowedNsfwLevel: PG_PG13,
    buzzType: 'green',
    source: 'User',
    basePrizePool: 100,
    createdById: 7,
    collectionId: 55,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.challenge.update.mockResolvedValue({});
  mockDbWrite.collection.update.mockResolvedValue({});
  mockDbRead.collection.findUnique.mockResolvedValue({ metadata: { forcedBrowsingLevel: PG_PG13 } });
  mockRefundMultiAccountTransaction.mockResolvedValue({ refundedTransactions: [{}] });
  mockCreateNotification.mockResolvedValue(undefined);
});

describe('applyChallengeNsfwEscalation', () => {
  it('clean scan: marks Scanned, no level raise, no flip, no refund', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge());
    await applyChallengeNsfwEscalation({ entityId: 1, isNsfw: false });

    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Scanned');
    expect(data.nsfwLevel).toBe(2); // PG13
    expect(data.allowedNsfwLevel).toBe(PG_PG13);
    expect(data.buzzType).toBeUndefined();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.update).not.toHaveBeenCalled();
  });

  it('green + nsfw + prize: refunds BEFORE update, flips, zeroes pool, raises level, updates collection, notifies', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge());
    const order: string[] = [];
    mockRefundMultiAccountTransaction.mockImplementation(async () => {
      order.push('refund');
      return { refundedTransactions: [{}] };
    });
    mockDbWrite.challenge.update.mockImplementation(async () => {
      order.push('update');
      return {};
    });

    await applyChallengeNsfwEscalation({ entityId: 42, isNsfw: true });

    expect(order).toEqual(['refund', 'update']);
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'challenge-initial-prize-42-creator-green',
      })
    );
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBe('yellow');
    expect(data.allowedNsfwLevel).toBe(PG_PG13 | R);
    expect(data.nsfwLevel).toBe(R);
    expect(data.basePrizePool).toBe(0);
    expect(data.prizePool).toBe(0);
    expect(data.ingestion).toBe('Scanned');

    const colData = mockDbWrite.collection.update.mock.calls[0][0].data;
    expect(colData.metadata.forcedBrowsingLevel).toBe(PG_PG13 | R);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-flipped-42' })
    );
  });

  it('green + nsfw + no prize: flips, no refund', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge({ basePrizePool: 0 }));
    await applyChallengeNsfwEscalation({ entityId: 3, isNsfw: true });
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBe('yellow');
    expect(data.basePrizePool).toBeUndefined();
  });

  it('already-yellow retry: no flip, no refund (idempotent)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge({ buzzType: 'yellow', basePrizePool: 0 }));
    await applyChallengeNsfwEscalation({ entityId: 9, isNsfw: true });
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBeUndefined();
    expect(data.allowedNsfwLevel).toBe(PG_PG13 | R); // level still raised
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-raised-9' })
    );
  });

  it('missing challenge: no-op', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);
    await applyChallengeNsfwEscalation({ entityId: 404, isNsfw: true });
    expect(mockDbWrite.challenge.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts`
Expected: FAIL — module `./challenge-nsfw-escalation` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/server/games/daily-challenge/challenge-nsfw-escalation.ts`:

```ts
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  computeNsfwEscalation,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
import { createNotification } from '~/server/services/notification.service';
import { refundMultiAccountTransaction } from '~/server/services/buzz.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { ChallengeIngestionStatus, ChallengeSource } from '~/shared/utils/prisma/enums';

// Applies the scan verdict to a challenge: marks it Scanned, and on an NSFW verdict raises the
// rating to R, flips a green USER challenge to yellow (moving it off the safe site via the
// domain-currency gate), refunds its green initial prize, and notifies the creator.
//
// Idempotent: the flip is gated on the STORED buzzType === 'green', so a retried callback (already
// yellow) skips the flip + refund. The refund runs BEFORE the challenge update so a crash between
// them re-reads a still-green row and re-attempts the (idempotent) refund rather than stranding it.
export async function applyChallengeNsfwEscalation({
  entityId,
  isNsfw,
}: {
  entityId: number;
  isNsfw: boolean;
}): Promise<void> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: entityId },
    select: {
      allowedNsfwLevel: true,
      buzzType: true,
      source: true,
      basePrizePool: true,
      createdById: true,
      collectionId: true,
    },
  });
  if (!challenge) return;

  const buzzType: ChallengeBuzzType = challenge.buzzType === 'green' ? 'green' : 'yellow';
  const escalation = computeNsfwEscalation({
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    buzzType,
    source: challenge.source,
    basePrizePool: challenge.basePrizePool,
    isNsfw,
  });

  // Refund first (idempotent) so a crash before the update re-runs the refund instead of stranding
  // the green charge once the row is flipped to yellow.
  if (escalation.refundInitialPrize) {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: `challenge-initial-prize-${entityId}-creator-green`,
      description: 'Challenge flipped to adult site — initial prize refund',
      details: { challengeId: entityId },
    });
  }

  await dbWrite.challenge.update({
    where: { id: entityId },
    data: {
      ingestion: ChallengeIngestionStatus.Scanned,
      scannedAt: new Date(),
      nsfwLevel: escalation.nsfwLevel,
      allowedNsfwLevel: escalation.allowedNsfwLevel,
      ...(escalation.flip && { buzzType: 'yellow' }),
      ...(escalation.refundInitialPrize && { basePrizePool: 0, prizePool: 0 }),
    },
  });

  // Keep the collection's entry-gating level in step with the raised allowed level.
  if (isNsfw && challenge.collectionId) {
    const collection = await dbRead.collection.findUnique({
      where: { id: challenge.collectionId },
      select: { metadata: true },
    });
    await dbWrite.collection.update({
      where: { id: challenge.collectionId },
      data: {
        metadata: {
          ...(collection?.metadata as CollectionMetadataSchema),
          forcedBrowsingLevel: escalation.allowedNsfwLevel,
        },
      },
    });
  }

  if (!challenge.createdById) return;

  if (escalation.flip) {
    await createNotification({
      userId: challenge.createdById,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `challenge-nsfw-flipped-${entityId}`,
      details: {
        message: escalation.refundInitialPrize
          ? "Your challenge's text was flagged as adult content, so it was moved to the adult site (civitai.red) and its rating raised to R. Your initial prize was refunded."
          : "Your challenge's text was flagged as adult content, so it was moved to the adult site (civitai.red) and its rating raised to R.",
        url: `/challenges/${entityId}`,
      },
    });
  } else if (isNsfw && escalation.nsfwLevel > deriveBase(challenge.allowedNsfwLevel)) {
    await createNotification({
      userId: challenge.createdById,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `challenge-nsfw-raised-${entityId}`,
      details: {
        message:
          "Your challenge's rating was raised to R based on its text, so it won't appear in safe-mode feeds.",
        url: `/challenges/${entityId}`,
      },
    });
  }
}

// Local helper: the display level implied by the ORIGINAL allowed mask, to detect an actual raise.
function deriveBase(allowedNsfwLevel: number): number {
  return computeNsfwEscalation({
    allowedNsfwLevel,
    buzzType: 'yellow',
    source: ChallengeSource.User,
    basePrizePool: 0,
    isNsfw: false,
  }).nsfwLevel;
}
```

Note: `escalation.nsfwLevel > deriveBase(...)` guards the "raised" notification so a yellow challenge already at/above R doesn't spuriously notify. `deriveBase` reuses `computeNsfwEscalation` with `isNsfw:false` to get the pre-raise display level without importing `deriveChallengeNsfwLevel` directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/challenge-nsfw-escalation.ts src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts
git commit -m "feat(challenge): applyChallengeNsfwEscalation IO helper

Applies a scan verdict: marks Scanned, raises to R, flips green->yellow, refunds
the green initial prize (refund-before-update for crash safety), updates the
collection browsing level, and notifies the creator. Idempotent on retry.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Delegate the adapter's applyResult to the helper

**Files:**
- Modify: `src/server/services/challenge-moderation.adapter.ts:47-96` (the `applyResult` function)

**Interfaces:**
- Consumes: `applyChallengeNsfwEscalation` (Task 4).
- Produces: `applyResult` keeps the `blocked` path; the clean/NSFW path delegates to the helper with `isNsfw = triggeredLabels.length > 0`.

- [ ] **Step 1: Rewrite `applyResult`**

In `src/server/services/challenge-moderation.adapter.ts`:

Add the import (near the other `~/server/games/daily-challenge/...` imports):

```ts
import { applyChallengeNsfwEscalation } from '~/server/games/daily-challenge/challenge-nsfw-escalation';
```

Replace the entire `applyResult` body (currently lines 47-96) with:

```ts
  applyResult: async ({ entityId, blocked, triggeredLabels }) => {
    if (blocked) {
      const challenge = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      await dbWrite.challenge.update({
        where: { id: entityId },
        data: { ingestion: ChallengeIngestionStatus.Blocked, scannedAt: new Date() },
      });
      if (challenge?.createdById) {
        await createNotification({
          userId: challenge.createdById,
          category: NotificationCategory.System,
          type: 'system-message',
          key: `challenge-text-blocked-${entityId}`,
          details: {
            message: 'Your challenge was hidden because its text violates our Terms of Service.',
            url: `/challenges/${entityId}`,
          },
        });
      }
      return;
    }

    // Any of nsfw / suggestive / explicit crossing threshold escalates the challenge.
    await applyChallengeNsfwEscalation({ entityId, isNsfw: triggeredLabels.length > 0 });
  },
```

- [ ] **Step 2: Remove now-unused imports**

`deriveChallengeNsfwLevel` and `NsfwLevel` are no longer referenced in the adapter (the escalation moved to the helper). Remove them:
- Delete line 8: `import { deriveChallengeNsfwLevel } from '~/server/games/daily-challenge/daily-challenge.utils';`
- Change line 1 from `import { NotificationCategory, NsfwLevel } from '~/server/common/enums';` to `import { NotificationCategory } from '~/server/common/enums';`

Verify no other reference remains:

Run: `grep -n "deriveChallengeNsfwLevel\|NsfwLevel" src/server/services/challenge-moderation.adapter.ts`
Expected: no matches.

- [ ] **Step 3: Run the adapter + helper tests**

Run: `pnpm vitest run src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts src/server/games/daily-challenge/challenge-currency.test.ts src/server/games/daily-challenge/challenge-funding.test.ts`
Expected: PASS.

Also run any existing adapter/scan tests to confirm no regression:

Run: `pnpm vitest run src/server/services/__tests__/challenge-edit-rescan.service.test.ts src/server/services/__tests__/challenge-review.service.test.ts`
Expected: PASS (or the same pre-existing failures noted on the branch; new failures are regressions to fix).

- [ ] **Step 4: Commit**

```bash
git add src/server/services/challenge-moderation.adapter.ts
git commit -m "feat(challenge): delegate scan applyResult to escalation helper

The adapter now keeps only the Blocked path; clean/NSFW verdicts route through
applyChallengeNsfwEscalation, treating any triggered label as NSFW.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run all touched test files**

Run:
```bash
pnpm vitest run \
  src/server/games/daily-challenge/challenge-funding.test.ts \
  src/server/games/daily-challenge/challenge-currency.test.ts \
  src/server/games/daily-challenge/challenge-nsfw-escalation.test.ts \
  src/server/games/daily-challenge/challenge-helpers.test.ts \
  src/server/services/__tests__/challenge-edit-rescan.service.test.ts \
  src/server/services/__tests__/challenge-review.service.test.ts
```
Expected: PASS (modulo pre-existing branch failures unrelated to this change).

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes with no NEW errors in the touched files. (Confirm it actually finished — see the 8GB-heap note; do not trust a bare `tsc`.)

- [ ] **Step 3: End-to-end sanity (manual, post-deploy or dev)**

Re-scan challenge 406 (edit its text, or force a rescan) and confirm via DB: `buzzType` → `yellow`, `allowedNsfwLevel` includes R (bit 4), `nsfwLevel` = 4, `ingestion` = Scanned, and the collection's `forcedBrowsingLevel` matches. This step is for the human operator, not automated.

---

## Notes for the implementer

- **Manual DB step:** none. No schema/migration change.
- **Existing prod challenges:** unaffected by the `externalTransactionId` change — old rows keep their `-creator` id; the refund prefix still matches them.
- **Deploy caveat:** the flip only takes effect once the domain-currency gate (already live, `challenge.service.ts:429-437`) is respected by the reading site (`isGreen`). No new flag is introduced.
