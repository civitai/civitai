import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBuzzLedger, insufficientFunds } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A donation whose charge ends with an unknown outcome (the ledger committed, the response was
 * lost) must charge once across the donor's retry, record the donation once, and tell the donor it
 * may have gone through when a resend cannot settle it. Driven against a fake ledger with the
 * multi-transaction endpoint's duplicate semantics.
 */

const { buzz, prefixRefund } = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => buzz);
vi.mock('~/server/services/buzz-prefix-refund', () => prefixRefund);

import { donateToGoal } from '~/server/services/donation-goal.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const DONOR = 20;
const CREATOR = 10;
const GOAL_ID = 77;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let donations: { buzzTransactionId: string; userId: number; amount: number }[];
let clock = 1_700_000_000_000;
let locks = createFakeAdvisoryLocks();

const donate = (idempotencyKey?: string, amount = 500) =>
  donateToGoal({
    donationGoalId: GOAL_ID,
    amount,
    userId: DONOR,
    buzzType: 'yellow',
    idempotencyKey,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.donationGoal.findUniqueOrThrow.mockResolvedValue({
    id: GOAL_ID,
    title: 'A goal',
    userId: CREATOR,
    active: true,
    entityType: null,
    entityId: null,
    goalAmount: 1000,
  } as never);
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ total: 0 }] as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ total: 0 }] as never);

  donations = [];
  dbMock.dbWrite.donation.create.mockImplementation((async (args: {
    data: (typeof donations)[number];
  }) => {
    donations.push(args.data);
    return args.data;
  }) as never);
  dbMock.dbWrite.donation.findFirst.mockImplementation(
    (async (args: { where: { buzzTransactionId: string; userId: number } }) =>
      donations.find(
        (d) =>
          d.buzzTransactionId === args.where.buzzTransactionId && d.userId === args.where.userId
      ) ?? null) as never
  );

  // The keyed path records on the lock's transaction.
  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => Promise<unknown>) =>
    locks.transaction(cb, {
      donation: {
        create: (args: unknown) => dbMock.dbWrite.donation.create(args as never),
        findFirst: (args: unknown) => dbMock.dbWrite.donation.findFirst(args as never),
      },
    })) as never);

  // Reset, not just cleared: a once-queued answer a test never reached must not leak.
  for (const fn of Object.values(buzz)) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createMultiAccountBuzzTransaction.mockImplementation(
    ledger.createMultiAccountBuzzTransaction
  );
  buzz.refundMultiAccountTransaction.mockImplementation(ledger.refundMultiAccountTransaction);
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation(
    ledger.getMultiAccountTransactionsByPrefix
  );
  prefixRefund.getPrefixRefundState.mockImplementation(ledger.getPrefixRefundState);
  // Each attempt is a later moment, as it is for a donor pressing donate again.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
});

describe('a donation across an unknown outcome', () => {
  it('a retry with the same key after an unanswered charge charges once and records once', async () => {
    // The charge and its resend both go unanswered.
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    // What the donor is told is pinned below; here only that it failed and recorded nothing.
    await expect(donate(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(donations).toHaveLength(0);

    await donate(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(500);
    expect(donations).toHaveLength(1);
  });

  it('records the donation in the same request when the resend answers', async () => {
    ledger.queueFault('lose-response');

    await donate(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(2);
    expect(donations).toHaveLength(1);
  });

  it('answers "may have gone through" when the resend also fails, and records nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await donate(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(donations).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(0);
  });

  it('a decline is not resent', async () => {
    buzz.createMultiAccountBuzzTransaction.mockRejectedValueOnce(insufficientFunds());

    await expect(donate(KEY)).rejects.toThrow('Failed to create donation');
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  it('a retry after the donation was recorded (response lost) charges nothing more', async () => {
    await donate(KEY);

    await donate(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(donations).toHaveLength(1);
  });

  it('refuses to record a charge that was refunded, so the client starts over', async () => {
    dbMock.dbWrite.donation.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(donate(KEY)).rejects.toThrow('Failed to create donation');
    expect(ledger.refunds()).toHaveLength(1);

    const error = await donate(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(donations).toHaveLength(0);
  });

  it('a new donation (a new key) charges again', async () => {
    await donate(KEY);
    await donate(OTHER_KEY);

    expect(ledger.charges()).toHaveLength(2);
    expect(donations).toHaveLength(2);
  });

  it('a key reused for a different amount is a different donation, charged on its own', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await donate(KEY).catch(() => undefined);
    ledger.clearFaults();

    await donate(KEY, 300);

    expect(ledger.charges()).toHaveLength(2);
    expect(donations).toEqual([expect.objectContaining({ amount: 300 })]);
  });

  it('files the charge under the donor, the goal and the amount, then the key', async () => {
    await donate(KEY);
    expect(ledger.charges()[0].externalTransactionId).toBe(
      `donation-k-${GOAL_ID}-${DONOR}-500-${KEY}-0`
    );
  });

  // The first charge landed and spent the balance; the ledger checks the balance before it looks
  // at the ids, so only a lookup first can tell the retry its money already moved.
  it('a retry whose balance the first charge spent records the donation from that charge', async () => {
    ledger.setBalance(DONOR, 500);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(donate(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(DONOR)).toBe(0);

    await donate(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(donations).toHaveLength(1);
  });

  it('a lookup that fails before charging is "may have gone through", and charges nothing', async () => {
    ledger.failLookups();

    await expect(donate(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.charges()).toHaveLength(0);
    expect(donations).toHaveLength(0);
  });

  it('takes the lock on the donation prefix', async () => {
    await donate(KEY);
    expect(locks.taken()).toEqual([`donation-k-${GOAL_ID}-${DONOR}-500-${KEY}`]);
    // Every Buzz write under the lock has a deadline, so the lock cannot outlive a hung write.
    expect(buzz.createMultiAccountBuzzTransaction.mock.calls[0][1]).toEqual({ timeoutMs: 15_000 });
  });

  it('two requests with one key in flight: one charge, one donation', async () => {
    ledger.queueFault('hang');
    const first = donate(KEY);
    await settle();
    const second = donate(KEY);
    await settle();
    ledger.releaseHung();
    await Promise.all([first, second]);

    expect(ledger.charges()).toHaveLength(1);
    expect(donations).toHaveLength(1);
  });

  it('the first request refund after a failed record never reverses a charge the second recorded', async () => {
    let failRecord!: (error: Error) => void;
    dbMock.dbWrite.donation.create.mockImplementationOnce(
      (() => new Promise((_, reject) => (failRecord = reject))) as never
    );
    const first = donate(KEY).catch((e: unknown) => e);
    while (!failRecord) await settle();
    const second = donate(KEY).catch((e: unknown) => e);
    await settle();
    failRecord(new Error('write failed'));

    expect(await first).toMatchObject({ message: 'Failed to create donation' });
    expect(await second).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(ledger.refunds()).toHaveLength(1);
    expect(donations).toHaveLength(0);
  });
});
