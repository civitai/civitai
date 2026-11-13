import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBuzzLedger,
  insufficientFunds,
} from '~/server/services/__tests__/buzz-ledger.fake';

/**
 * An on-site tip whose batch write ends with an unknown outcome (the ledger committed, the
 * response was lost) must move the Buzz once across the tipper's retry, record the tip once, and
 * tell the tipper it may have gone through when the ledger cannot be asked.
 */

const { buzz, mockGetUserBuzzAccount, mockUpsertBuzzTip } = vi.hoisted(() => ({
  buzz: {
    createBuzzTransactionMany: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
  mockGetUserBuzzAccount: vi.fn(),
  mockUpsertBuzzTip: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...a: unknown[]) => buzz.createBuzzTransactionMany(...(a as [])),
  getTransactionByExternalId: (...a: unknown[]) => buzz.getTransactionByExternalId(...(a as [])),
  getUserBuzzAccount: (...a: unknown[]) => mockGetUserBuzzAccount(...(a as [])),
  upsertBuzzTip: (...a: unknown[]) => mockUpsertBuzzTip(...(a as [])),
  createBuzzTransaction: vi.fn(),
  recoverBuzzTransactionId: vi.fn(),
  completeStripeBuzzTransaction: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
  getMultipliersForUser: vi.fn(),
  getTransactionsReport: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getUserBuzzTransactionsMulti: vi.fn(),
  previewMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));
vi.mock('~/server/services/entity-collaborator.service', () => ({
  getEntityCollaborators: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({ getImageById: vi.fn(async () => null) }));
const { mockCreateNotification, mockUpdateEntityMetric } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockUpdateEntityMetric: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: (...a: unknown[]) => mockCreateNotification(...(a as [])),
}));
vi.mock('~/server/utils/metric-helpers', () => ({
  updateEntityMetric: (...a: unknown[]) => mockUpdateEntityMetric(...(a as [])),
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn() },
}));

import { createBuzzTipTransactionHandler } from '../buzz.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const TIPPER = 42;

const ctx = () => ({ user: { id: TIPPER, createdAt: new Date('2020-01-01T00:00:00Z') } } as never);
const imageTip = (idempotencyKey?: string, amount = 100) =>
  createBuzzTipTransactionHandler({
    input: {
      toAccountId: 5,
      amount,
      fromAccountType: 'yellow',
      toAccountType: 'yellow',
      entityType: 'Image',
      entityId: 77,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    } as never,
    ctx: ctx(),
  });

let ledger: ReturnType<typeof createFakeBuzzLedger>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserBuzzAccount.mockResolvedValue([{ balance: 1_000_000 }]);
  dbMock.dbWrite.user.findMany.mockResolvedValue([]);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ username: 'sender' } as never);
  mockUpsertBuzzTip.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  mockUpdateEntityMetric.mockResolvedValue(undefined);
  // Reset, not just cleared: a once-queued answer a test never reached must not leak.
  for (const fn of Object.values(buzz)) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createBuzzTransactionMany.mockImplementation(ledger.createBuzzTransactionMany);
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
});

describe('on-site tip across an unknown outcome', () => {
  it('a retry with the same key after an unanswered send moves the Buzz once', async () => {
    // The send and its resend both go unanswered: the tipper is told it may have gone through.
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    // What the tipper is told is pinned below; here only that it failed.
    await expect(imageTip(KEY)).rejects.toThrow();
    ledger.clearFaults();

    await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].externalTransactionId).toBe(`tip:${TIPPER}:${KEY}:100:Image:77-5`);
  });

  it('records the tip once, in the same request, when the resend answers', async () => {
    ledger.queueFault('lose-response');

    const result = await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.createBuzzTransactionMany).toHaveBeenCalledTimes(2);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpsertBuzzTip.mock.calls[0][0]).toMatchObject({ amount: 100, entityId: 77 });
    expect(mockUpdateEntityMetric).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deduped: false });
  });

  it('moves the Buzz once through the resend when the first send moved nothing', async () => {
    ledger.queueFault('fail-before-commit');

    await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
  });

  it('answers "may have gone through" when the resend also fails, and records nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await imageTip(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(mockUpsertBuzzTip).not.toHaveBeenCalled();
    expect(mockUpdateEntityMetric).not.toHaveBeenCalled();
  });

  it('answers "may have gone through" when the resend leaves a leg unaccounted for', async () => {
    ledger.queueFault('fail-before-commit');
    // The ledger drops an insufficient-funds leg from both lists.
    buzz.createBuzzTransactionMany
      .mockImplementationOnce(ledger.createBuzzTransactionMany)
      .mockResolvedValueOnce({ transactions: [], conflicts: [] });

    await expect(imageTip(KEY)).rejects.toThrow(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(mockUpsertBuzzTip).not.toHaveBeenCalled();
  });

  it('passes a decline through unchanged, without a resend', async () => {
    buzz.createBuzzTransactionMany.mockRejectedValueOnce(insufficientFunds());

    await expect(imageTip(KEY)).rejects.toThrow(/enough funds/);
    expect(buzz.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
  });

  it('a new tip (a new key) moves the Buzz again', async () => {
    await imageTip(KEY);
    await imageTip(OTHER_KEY);

    expect(ledger.charges()).toHaveLength(2);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(2);
  });

  // A key held after a lost response and sent with a different tip: that tip is its own, charged
  // and recorded, never answered from the earlier tip's charge.
  it('a key reused for a different amount is a different tip, moved and recorded on its own', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await imageTip(KEY).catch(() => undefined);
    ledger.clearFaults();

    const result = await imageTip(KEY, 250);

    expect(ledger.charges()).toHaveLength(2);
    expect(ledger.charges()[1].amount).toBe(250);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpsertBuzzTip.mock.calls[0][0]).toMatchObject({ amount: 250 });
    expect(result).toMatchObject({ deduped: false });
  });

  it('without a key, an unknown outcome is rethrown without a resend, as before', async () => {
    ledger.queueFault('lose-response');

    await expect(imageTip()).rejects.toThrow('timeout');
    expect(buzz.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
  });
});
