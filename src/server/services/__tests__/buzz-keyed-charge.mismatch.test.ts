import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createFakeBuzzLedger } from './buzz-ledger.fake';

/**
 * `chargeByExternalId` with a reused id: the ledger answers an id it holds with the transaction it
 * holds, whatever the request sent. The charge is only this request's when the held transaction
 * has this request's terms; otherwise the request is refused before its caller records anything.
 */

const { buzz } = vi.hoisted(() => ({
  buzz: {
    createBuzzTransaction: vi.fn(),
    resendBuzzTransaction: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
}));
vi.mock('~/server/services/buzz.service', () => buzz);

const { chargeByExternalId, heldChargeMatches } = await import('../buzz-keyed-charge');

// Literal: the user-facing contract.
const CHARGE_MISMATCH_MESSAGE =
  'This request does not match the earlier attempt with the same key. Please start again.';

const ID = 'creator-cash-withdrawal-42-6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const charge = (overrides: { amount?: number; toAccountId?: number } = {}) => ({
  amount: 10_000,
  fromAccountId: 42,
  fromAccountType: 'cashSettled' as const,
  toAccountId: 0,
  toAccountType: 'yellow' as const,
  type: TransactionType.Withdrawal,
  description: 'Withdrawal request',
  externalTransactionId: ID,
  ...overrides,
});

let ledger: ReturnType<typeof createFakeBuzzLedger>;

beforeEach(() => {
  for (const fn of Object.values(buzz)) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createBuzzTransaction.mockImplementation(ledger.createBuzzTransaction);
  buzz.resendBuzzTransaction.mockImplementation(ledger.resendBuzzTransaction);
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
});

const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe('chargeByExternalId with a reused id', () => {
  it('positive control: the same terms continue from the held charge, moving nothing', async () => {
    await chargeByExternalId(charge(), { reusable: true });

    const again = await chargeByExternalId(charge(), { reusable: true });

    expect(again.transactionId).toBe(ledger.charges()[0].transactionId);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('held before charging with another amount: refused with a 400, nothing resent', async () => {
    await chargeByExternalId(charge(), { reusable: true });
    buzz.resendBuzzTransaction.mockClear();

    const error = await refusal(
      chargeByExternalId(charge({ amount: 5_000_000 }), { reusable: true })
    );

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: CHARGE_MISMATCH_MESSAGE });
    expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a first send another request beat to the id, with other terms: refused after reading it back', async () => {
    await chargeByExternalId(charge(), { reusable: true });
    // This request's lookup ran before the other request's charge committed.
    buzz.getTransactionByExternalId.mockResolvedValueOnce(null);

    const error = await refusal(chargeByExternalId(charge({ amount: 7_000 }), { reusable: true }));

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: CHARGE_MISMATCH_MESSAGE });
    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(10_000);
  });

  it('an unknown outcome whose resend is answered with other terms: refused', async () => {
    await chargeByExternalId(charge(), { reusable: true });
    buzz.getTransactionByExternalId.mockResolvedValueOnce(null);
    // The send fails with an unknown outcome; the resend is answered with the held transaction.
    buzz.createBuzzTransaction.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );

    const error = await refusal(chargeByExternalId(charge({ amount: 7_000 }), { reusable: true }));

    expect(buzz.resendBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: CHARGE_MISMATCH_MESSAGE });
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a read-back that fails is "may have gone through", not a success', async () => {
    buzz.getTransactionByExternalId
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('buzz read failed'));

    const error = await refusal(chargeByExternalId(charge(), { reusable: true }));

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('a charge that reads back as not found once, then found, succeeds', async () => {
    buzz.getTransactionByExternalId
      .mockResolvedValueOnce(null) // before charging
      .mockResolvedValueOnce(null); // the first read-back lags the write

    const { transactionId } = await chargeByExternalId(charge(), { reusable: true });

    expect(transactionId).toBe(ledger.charges()[0].transactionId);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a charge that never reads back is "may have gone through", after a bounded number of reads', async () => {
    buzz.getTransactionByExternalId.mockResolvedValue(null);

    const error = await refusal(chargeByExternalId(charge(), { reusable: true }));

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    // One read before charging, then the read-back and three re-reads.
    expect(buzz.getTransactionByExternalId).toHaveBeenCalledTimes(5);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('matchAmount false: a held charge of another amount continues; other terms are still refused', async () => {
    await chargeByExternalId(charge(), { reusable: true });

    const again = await chargeByExternalId(charge({ amount: 25_000 }), {
      reusable: true,
      matchAmount: false,
    });
    expect(again.transactionId).toBe(ledger.charges()[0].transactionId);

    const other = await refusal(
      chargeByExternalId(charge({ amount: 25_000, toAccountId: 9 }), {
        reusable: true,
        matchAmount: false,
      })
    );
    expect(other).toMatchObject({ code: 'BAD_REQUEST', message: CHARGE_MISMATCH_MESSAGE });
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a retry declined for funds while its earlier charge is held but not yet readable continues from it', async () => {
    // The earlier attempt's charge committed and spent the whole balance; its answer was lost.
    ledger.setBalance(42, 10_000);
    await chargeByExternalId(charge(), { reusable: true });
    expect(ledger.balanceOf(42)).toBe(0);
    buzz.getTransactionByExternalId
      .mockResolvedValueOnce(null) // the lookup before charging lags the write
      .mockResolvedValueOnce(null); // so does the first re-read after the decline

    const { transactionId } = await chargeByExternalId(charge(), { reusable: true });

    expect(transactionId).toBe(ledger.charges()[0].transactionId);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a decline with nothing held under the id is still a decline, after the bounded re-reads', async () => {
    ledger.setBalance(42, 0);

    await expect(chargeByExternalId(charge(), { reusable: true })).rejects.toThrow(/enough funds/);
    // One read before charging, then the re-read and three retries after the decline.
    expect(buzz.getTransactionByExternalId).toHaveBeenCalledTimes(5);
    expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(0);
  });

  it('without reuse, no lookup at all', async () => {
    await chargeByExternalId(charge(), { reusable: false });
    expect(buzz.getTransactionByExternalId).not.toHaveBeenCalled();
  });
});

describe('heldChargeMatches', () => {
  // Every field distinct from every other, so a check reading the wrong field cannot pass.
  const input = {
    amount: 1_111,
    fromAccountId: 2_222,
    toAccountId: 3_333,
    fromAccountType: 'cashSettled',
    type: TransactionType.Withdrawal,
  };
  const held = { ...input, fromAccountType: 'cashsettled' };

  it('matches the same terms (account type compared without case)', () => {
    expect(heldChargeMatches(held, input)).toBe(true);
  });

  it.each([
    ['amount', { amount: 1_112 }],
    ['payer', { fromAccountId: 2_223 }],
    ['payee', { toAccountId: 3_334 }],
    ['source account type', { fromAccountType: 'yellow' }],
    ['transaction type', { type: TransactionType.Tip }],
  ])('refuses another %s', (_name, change) => {
    expect(heldChargeMatches({ ...held, ...change }, input)).toBe(false);
  });

  it('matchAmount false ignores only the amount', () => {
    expect(heldChargeMatches({ ...held, amount: 9 }, input, { matchAmount: false })).toBe(true);
    expect(
      heldChargeMatches({ ...held, amount: 9, fromAccountId: 2_223 }, input, { matchAmount: false })
    ).toBe(false);
  });

  it('a field the ledger did not return is not compared; amount, payer and payee always are', () => {
    expect(heldChargeMatches({ ...held, fromAccountType: undefined, type: undefined }, input)).toBe(
      true
    );
    expect(heldChargeMatches({ ...held, amount: undefined }, input)).toBe(false);
  });
});
