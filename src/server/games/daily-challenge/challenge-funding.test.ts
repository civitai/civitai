import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies chargeEntryFees' two-leg (house + pool) charging and its NO-REFUND partial-failure
// contract: the buzz ledger keeps a refunded externalTransactionId occupied and exposes no
// refund state, so refunding a leg would make a later retry treat it as "already paid" and
// commit the entry for free. chargeEntryFees must therefore never refund; it partitions images
// into fully-paid (committable) and unpaid, and half-paid images self-heal on retry.

const {
  mockCreateBuzzTransaction,
  mockCreateBuzzTransactionMany,
  mockGetTransactionByExternalId,
  mockRefundMultiAccountTransaction,
  mockRefundTransaction,
  mockChallengeUpdate,
  mockChallengeFindUnique,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockCreateBuzzTransaction: vi.fn(),
  mockCreateBuzzTransactionMany: vi.fn(),
  mockGetTransactionByExternalId: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn().mockResolvedValue({ refundedTransactions: [] }),
  mockRefundTransaction: vi.fn(),
  mockChallengeUpdate: vi.fn(),
  mockChallengeFindUnique: vi.fn(),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { challenge: { findUnique: mockChallengeFindUnique } },
  dbWrite: { challenge: { update: mockChallengeUpdate } },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mockCreateBuzzTransaction,
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: mockGetTransactionByExternalId,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
  refundTransaction: mockRefundTransaction,
}));

const { chargeEntryFees, chargeInitialPrize, refundUserChallengeFunds, buildWinnerPayoutTransactions } =
  await import('./challenge-funding');
const { CHALLENGE_ENTRY_HOUSE_CUT, getEntryPoolContribution } = await import(
  '~/shared/constants/challenge.constants'
);
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

const CHALLENGE_ID = 7;
const USER_ID = 42;
const ENTRY_FEE = 100; // pool part = 75 with the 25 house cut

// createBuzzTransactionMany result builder: n new successes, c idempotency conflicts.
const batchResult = (n: number, conflicts: string[] = []) => ({
  transactions: Array.from({ length: n }, (_, i) => `txn-${i}`),
  conflicts,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRefundMultiAccountTransaction.mockResolvedValue({ refundedTransactions: [] });
  mockLogToAxiom.mockResolvedValue(undefined);
});

describe('chargeEntryFees — happy paths', () => {
  it('no-op for zero fee: everything is committable, no buzz calls', async () => {
    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [1, 2],
      entryFee: 0,
      fromAccountType: 'yellow',
    });
    expect(result).toEqual({ paidImageIds: [1, 2], unpaidImageIds: [] });
    expect(mockCreateBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('charges a house leg and a pool leg per image, with the documented id scheme', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(2)) // house batch
      .mockResolvedValueOnce(batchResult(2)); // pool batch

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10, 11],
      entryFee: ENTRY_FEE,
      fromAccountType: 'yellow',
    });

    expect(result).toEqual({ paidImageIds: [10, 11], unpaidImageIds: [] });

    const [houseBatch] = mockCreateBuzzTransactionMany.mock.calls[0];
    const [poolBatch] = mockCreateBuzzTransactionMany.mock.calls[1];
    expect(houseBatch.map((t: any) => t.externalTransactionId)).toEqual([
      'challenge-entry-house-7-10',
      'challenge-entry-house-7-11',
    ]);
    expect(houseBatch.every((t: any) => t.amount === CHALLENGE_ENTRY_HOUSE_CUT)).toBe(true);
    expect(poolBatch.map((t: any) => t.externalTransactionId)).toEqual([
      'challenge-entry-fee-7-10',
      'challenge-entry-fee-7-11',
    ]);
    expect(poolBatch.every((t: any) => t.amount === ENTRY_FEE - CHALLENGE_ENTRY_HOUSE_CUT)).toBe(
      true
    );

    // Pool grows by contribution × NEW pool charges.
    expect(mockChallengeUpdate).toHaveBeenCalledWith({
      where: { id: CHALLENGE_ID },
      data: { prizePool: { increment: getEntryPoolContribution(ENTRY_FEE) * 2 } },
    });
  });

  it('retry with everything already paid: all conflicts, paid, and NO pool growth', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(0, ['challenge-entry-house-7-10']))
      .mockResolvedValueOnce(batchResult(0, ['challenge-entry-fee-7-10']));

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10],
      entryFee: ENTRY_FEE,
      fromAccountType: 'yellow',
    });

    expect(result).toEqual({ paidImageIds: [10], unpaidImageIds: [] });
    expect(mockChallengeUpdate).not.toHaveBeenCalled();
  });

  it('fee at or below the house cut: single house-only leg, no pool batch', async () => {
    mockCreateBuzzTransactionMany.mockResolvedValueOnce(batchResult(1));

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10],
      entryFee: CHALLENGE_ENTRY_HOUSE_CUT,
      fromAccountType: 'yellow',
    });

    expect(result).toEqual({ paidImageIds: [10], unpaidImageIds: [] });
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(mockChallengeUpdate).not.toHaveBeenCalled();
  });
});

describe('chargeEntryFees — partial failure (the no-refund contract)', () => {
  it('pool shortfall: paid = ledger-verified subset, NOTHING refunded, house orphans logged', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(3)) // house: all 3 settle
      .mockResolvedValueOnce(batchResult(1)); // pool: only 1 of 3 settles (2 dropped: no funds)
    // Ledger truth for the pool legs: image 10 charged, 11/12 missing.
    mockGetTransactionByExternalId.mockImplementation(async (extId: string) =>
      extId === 'challenge-entry-fee-7-10' ? { amount: 75 } : null
    );

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10, 11, 12],
      entryFee: ENTRY_FEE,
      fromAccountType: 'yellow',
    });

    expect(result.paidImageIds).toEqual([10]);
    expect(result.unpaidImageIds).toEqual([11, 12]);

    // THE invariant: no refund of any kind on the partial path (a refunded leg would read as
    // an idempotency conflict on retry and let the entry commit for free).
    expect(mockRefundTransaction).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();

    // Pool still grows by the ONE new pool charge (that image is committable).
    expect(mockChallengeUpdate).toHaveBeenCalledWith({
      where: { id: CHALLENGE_ID },
      data: { prizePool: { increment: getEntryPoolContribution(ENTRY_FEE) * 1 } },
    });

    // House-only orphans surfaced for monitoring.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-entry-fee-partial-charge',
        houseOnlyImageIds: [11, 12],
      })
    );
  });

  it('house shortfall: pool is only attempted for house-settled images', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(1)) // house: 1 of 3 settles
      .mockResolvedValueOnce(batchResult(1)); // pool: that 1 settles
    mockGetTransactionByExternalId.mockImplementation(async (extId: string) =>
      extId === 'challenge-entry-house-7-10' ? { amount: 25 } : null
    );

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10, 11, 12],
      entryFee: ENTRY_FEE,
      fromAccountType: 'yellow',
    });

    expect(result.paidImageIds).toEqual([10]);
    expect(result.unpaidImageIds).toEqual([11, 12]);

    const [poolBatch] = mockCreateBuzzTransactionMany.mock.calls[1];
    expect(poolBatch.map((t: any) => t.externalTransactionId)).toEqual([
      'challenge-entry-fee-7-10',
    ]);
    expect(mockRefundTransaction).not.toHaveBeenCalled();
  });

  it('half-paid image self-heals on retry: house conflicts, pool charges fresh', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(0, ['challenge-entry-house-7-10'])) // prior house leg
      .mockResolvedValueOnce(batchResult(1)); // pool leg charged now

    const result = await chargeEntryFees({
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      imageIds: [10],
      entryFee: ENTRY_FEE,
      fromAccountType: 'yellow',
    });

    expect(result).toEqual({ paidImageIds: [10], unpaidImageIds: [] });
    expect(mockChallengeUpdate).toHaveBeenCalledWith({
      where: { id: CHALLENGE_ID },
      data: { prizePool: { increment: getEntryPoolContribution(ENTRY_FEE) * 1 } },
    });
  });
});

describe('chargeInitialPrize fromAccountType', () => {
  it('forwards fromAccountType to createBuzzTransaction', async () => {
    mockCreateBuzzTransaction.mockResolvedValueOnce({});

    await chargeInitialPrize({
      challengeId: 3,
      userId: 1,
      amount: 1000,
      fromAccountType: 'green',
    });

    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountType: 'green', amount: 1000 })
    );
  });
});

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

describe('chargeEntryFees fromAccountType', () => {
  it('forwards fromAccountType to both house and pool legs', async () => {
    mockCreateBuzzTransactionMany
      .mockResolvedValueOnce(batchResult(1)) // house batch
      .mockResolvedValueOnce(batchResult(1)); // pool batch

    await chargeEntryFees({
      challengeId: 3,
      userId: 1,
      imageIds: [10],
      entryFee: 100,
      fromAccountType: 'green',
    });

    for (const call of mockCreateBuzzTransactionMany.mock.calls) {
      expect(call[0][0]).toEqual(expect.objectContaining({ fromAccountType: 'green' }));
    }
  });
});

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

describe('refundUserChallengeFunds — void refunds pool legs only', () => {
  it('refunds the pool prefix and the initial prize prefix, never the house prefix', async () => {
    mockChallengeFindUnique.mockResolvedValue({
      source: ChallengeSource.User,
      basePrizePool: 500,
      createdById: USER_ID,
      entryFee: ENTRY_FEE,
    });

    await refundUserChallengeFunds(CHALLENGE_ID);

    const prefixes = mockRefundMultiAccountTransaction.mock.calls.map(
      ([input]) => input.externalTransactionIdPrefix
    );
    expect(prefixes).toEqual([
      'challenge-entry-fee-7-',
      'challenge-initial-prize-7-creator',
    ]);
    expect(prefixes.some((p: string) => p.includes('house'))).toBe(false);
  });

  it('no-op for non-User challenges', async () => {
    mockChallengeFindUnique.mockResolvedValue({
      source: ChallengeSource.System,
      basePrizePool: 500,
      createdById: USER_ID,
      entryFee: ENTRY_FEE,
    });

    const result = await refundUserChallengeFunds(CHALLENGE_ID);
    expect(result).toEqual({ refundedEntries: 0 });
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});
