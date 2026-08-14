import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A multi-account charge that pays a USER must name the destination account type.
 *
 * It used to default to `'yellow'` when omitted, which four separate features shipped
 * without noticing (#3911, #3917, #3919, #3921): a green purchase paid the seller yellow,
 * silently, with no error and no log. Paying the BANK (account 0) may still omit it —
 * the bank is a ledger, not a balance, and it pays out in colours it was never credited in.
 */

import type * as BuzzClient from '@civitai/buzz';

const { createMultiTransaction } = vi.hoisted(() => ({ createMultiTransaction: vi.fn() }));

// Spread the real package and override only the client factory: a hand-listed factory would
// couple this file to every export buzz.service happens to import from it.
vi.mock('@civitai/buzz', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzClient>()),
  createBuzzClient: () => ({ createMultiTransaction }),
}));

import { createMultiAccountBuzzTransaction } from '~/server/services/buzz.service';

const SELLER = 4242;
const BANK = 0;

const charge = (overrides: Record<string, unknown>) =>
  createMultiAccountBuzzTransaction({
    fromAccountId: 111,
    fromAccountTypes: ['green'],
    amount: 500,
    externalTransactionIdPrefix: 'test-prefix',
    ...overrides,
  } as Parameters<typeof createMultiAccountBuzzTransaction>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  createMultiTransaction.mockResolvedValue({
    transactionIds: [{ transactionId: 'tx-1', accountType: 'user', amount: 500 }],
    totalAmount: 500,
    transactionCount: 1,
  });
});

describe('createMultiAccountBuzzTransaction destination', () => {
  it('refuses a user destination with no account type instead of paying yellow', async () => {
    // Resolved-vs-rejected as data, so a regression reports the currency the seller WOULD have
    // been paid in rather than "promise resolved instead of rejecting".
    const outcome = await charge({ toAccountId: SELLER }).then(
      () => ({ paidWith: createMultiTransaction.mock.calls[0]?.[0]?.toAccountType }),
      (error: Error) => ({ refusedWith: error.message })
    );

    expect(outcome).toEqual({ refusedWith: expect.stringContaining('toAccountType is required') });
    expect(createMultiTransaction).not.toHaveBeenCalled();
  });

  it('pays a user in the account type named, not the default', async () => {
    await charge({ toAccountId: SELLER, toAccountType: 'green' });

    expect(createMultiTransaction).toHaveBeenCalledTimes(1);
    const [payload] = createMultiTransaction.mock.calls[0];
    expect(payload.toAccountId).toBe(SELLER);
    expect(payload.toAccountType).toBe('green');
  });

  it('lets a bank charge omit the account type and books it as yellow', async () => {
    await charge({ toAccountId: BANK });

    const [payload] = createMultiTransaction.mock.calls[0];
    expect(payload.toAccountId).toBe(BANK);
    expect(payload.toAccountType).toBe('yellow');
  });
});
