import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBuzzLedger,
  insufficientFunds,
} from '~/server/services/__tests__/buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from '~/server/services/__tests__/charge-lock.fake';

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
import { redisMock } from '~/__tests__/mocks/redis.mock';

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
let locks = createFakeAdvisoryLocks();
const claims = new Map<string, string>();

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
  // The record claim's store: SET NX semantics.
  claims.clear();
  redisMock.sysRedis.set.mockImplementation((async (
    key: string,
    value: string,
    options?: { NX?: boolean }
  ) => {
    if (options?.NX && claims.has(key)) return null;
    claims.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.get.mockImplementation(
    (async (key: string) => claims.get(key) ?? null) as never
  );
  ledger = createFakeBuzzLedger();
  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => Promise<unknown>) =>
    locks.transaction(cb, {})) as never);
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
    // Pinned: the retry moved nothing, so it records nothing. upsertBuzzTip adds to a running
    // total and there is no per-key record to tell whether the first request recorded, so the
    // tip record, notification and metric for legs an earlier request moved are not written again.
    expect(mockUpsertBuzzTip).not.toHaveBeenCalled();
    expect(mockUpdateEntityMetric).not.toHaveBeenCalled();
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

  // The first send moved the Buzz and spent the balance: the retry is answered from the moved
  // legs, not refused as "insufficient funds" (a 400 the client reads as "start a new tip").
  it('a retry whose balance the first send spent is answered from the moved legs', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(imageTip(KEY)).rejects.toThrow();
    ledger.clearFaults();
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 0 }]);

    const result = await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(result).toMatchObject({ deduped: true });
    expect(mockUpsertBuzzTip).not.toHaveBeenCalled();
    expect(mockUpdateEntityMetric).not.toHaveBeenCalled();
  });

  it('still refuses a short balance for legs not yet moved', async () => {
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 99 }]);

    await expect(imageTip(KEY)).rejects.toThrow(/enough funds/);
    expect(ledger.charges()).toHaveLength(0);
  });

  // A slow Buzz service must not hold the app's write pool: a tip opens no transaction at all,
  // and its record writes are the ones it always made.
  it('holds no transaction while the Buzz send is pending, and takes no lock', async () => {
    ledger.queueFault('hang');
    const tipped = imageTip(KEY);
    while (!ledger.isHung()) await settle();
    expect(locks.open()).toBe(0);
    ledger.releaseHung();
    await tipped;
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(locks.taken()).toEqual([]);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
  });

  it('two requests with one key in flight: the ledger moves the Buzz once and only the mover records', async () => {
    ledger.queueFault('hang');
    const first = imageTip(KEY);
    await settle();
    const second = imageTip(KEY);
    await settle();
    ledger.releaseHung();
    const results = await Promise.all([first, second]);

    expect(ledger.charges()).toHaveLength(1);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpdateEntityMetric).toHaveBeenCalledTimes(1);
    // The ledger gave the legs to one request; the other was answered as a replay.
    expect(results.filter((r) => r.deduped)).toHaveLength(1);
  });

  // A service that answers a leg it already holds as a success (with the existing id) makes the
  // batch answer ambiguous: here the first request commits between the second one's lookup and
  // its write, and both are answered with the leg as moved. One of them records.
  it("the first request committing between the second one's lookup and write: one tip record", async () => {
    ledger.setReplayShape('existing-id');
    ledger.queueFault('hang');
    const first = imageTip(KEY);
    while (!ledger.isHung()) await settle();
    buzz.getTransactionByExternalId.mockImplementationOnce(async () => {
      // The second request's lookup has run (nothing held yet); now the first one commits.
      ledger.releaseHung();
      await first;
      return null;
    });

    await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpdateEntityMetric).toHaveBeenCalledTimes(1);
  });

  // Fail open: without the claim store the tip is still recorded; the Buzz moved once regardless.
  it('records anyway when the claim store is down', async () => {
    redisMock.sysRedis.set.mockRejectedValue(new Error('redis down') as never);

    await imageTip(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
  });
});
