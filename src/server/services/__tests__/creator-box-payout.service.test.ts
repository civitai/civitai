import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A creator box sale pays the creator their pool, once per sale however often it is retried, and
// records the payout where the takedown and refunds reverse it.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createTx: vi.fn(),
    listMultiTx: vi.fn(),
    blockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createTx,
  getMultiAccountTransactionsByPrefix: mocks.listMultiTx,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.blockedPairIds,
}));

import {
  assertCreatorBoxSellable,
  payCreatorBoxSale,
  sweepCreatorBoxPayouts,
} from '../creator-box-payout.service';

const P = 'item-purchase-v1-1-42-key';
const SELLER = 7;
const BUYER = 1;
const sale = {
  buzzTransactionId: P,
  buyerId: BUYER,
  sellerId: SELLER,
  // floor(857 * 0.7) = 599: the creator's pool, the platform keeps 258.
  unitAmount: 857,
  color: 'yellow' as const,
  title: 'Pack',
};

// As `buzzService` throws it: the Buzz status wrapped in a TRPCError.
const buzzError = (status: number) =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'buzz', cause: new BuzzApiError(status, 'x') });
const conflict = () => buzzError(409);

/** The meta JSON the last `$executeRaw` merged into the purchase. */
const recordedMeta = () => {
  const call = dbMock.dbWrite.$executeRaw.mock.calls.at(-1);
  if (!call) return undefined;
  const values = call.slice(1) as unknown[];
  const json = values.find((v) => typeof v === 'string' && v.startsWith('{'));
  return json ? JSON.parse(json as string) : undefined;
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  dbMock.dbWrite.$executeRaw.mockReset();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.$queryRaw.mockReset();
  mocks.createTx.mockResolvedValue({ transactionId: 'payout-tx' });
  mocks.blockedPairIds.mockResolvedValue([]);
});

describe('payCreatorBoxSale', () => {
  it('pays the seller exactly the creator pool, in the colour charged, under the sale’s fixed id', async () => {
    await payCreatorBoxSale(sale);

    expect(mocks.createTx).toHaveBeenCalledTimes(1);
    expect(mocks.createTx.mock.calls[0][0]).toMatchObject({
      fromAccountId: 0,
      toAccountId: SELLER,
      toAccountType: 'yellow',
      amount: 599,
      externalTransactionId: `${P}:sell:${SELLER}:yellow`,
    });
    expect(recordedMeta()).toEqual({
      payouts: [{ userId: SELLER, amount: 599, color: 'yellow', transactionId: 'payout-tx' }],
      platformCut: 258,
    });
  });

  it('reads a payout that already landed back from the ledger instead of paying twice', async () => {
    mocks.createTx.mockRejectedValue(conflict());
    mocks.listMultiTx.mockResolvedValue([
      { transactionId: 'debit', externalTransactionId: `${P}-yellow`, accountId: BUYER },
      {
        transactionId: 'landed-payout',
        externalTransactionId: `${P}:sell:${SELLER}:yellow`,
        accountId: 0,
      },
    ]);

    await payCreatorBoxSale(sale);

    expect(mocks.listMultiTx).toHaveBeenCalledWith(P);
    expect(recordedMeta()?.payouts).toEqual([
      { userId: SELLER, amount: 599, color: 'yellow', transactionId: 'landed-payout' },
    ]);
  });

  it('records nothing when a 409 names no payout on the ledger', async () => {
    mocks.createTx.mockRejectedValue(conflict());
    mocks.listMultiTx.mockResolvedValue([]);

    await expect(payCreatorBoxSale(sale)).rejects.toThrow('not listed');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('records nothing when the payout fails for any other reason', async () => {
    mocks.createTx.mockRejectedValue(buzzError(503));

    await expect(payCreatorBoxSale(sale)).rejects.toThrow('buzz');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('assertCreatorBoxSellable', () => {
  const ok = { sellerId: SELLER, buyerId: BUYER, enabled: true, isPack: false, buzzType: 'yellow' };
  const activeSeller = () =>
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ muted: false, bannedAt: null, deletedAt: null }]);

  it('sells to another buyer when nothing refuses (control)', async () => {
    activeSeller();
    await expect(assertCreatorBoxSellable(ok as never)).resolves.toBeUndefined();
  });

  it('refuses the creator buying their own box, saying so', async () => {
    activeSeller();
    await expect(assertCreatorBoxSellable({ ...ok, buyerId: SELLER } as never)).rejects.toThrow(
      "You can't buy your own mystery pack"
    );
  });

  it.each([
    ['the flag is off', { enabled: false }],
    ['the listing has pack terms', { isPack: true }],
    ['the buyer pays in Blue', { buzzType: 'blue' }],
  ])('refuses when %s', async (_, override) => {
    activeSeller();
    await expect(assertCreatorBoxSellable({ ...ok, ...override } as never)).rejects.toThrow(
      'This box is not available'
    );
  });

  it.each([
    ['muted', { muted: true, bannedAt: null, deletedAt: null }],
    ['banned', { muted: false, bannedAt: new Date(), deletedAt: null }],
    ['deleted', { muted: false, bannedAt: null, deletedAt: new Date() }],
  ])('refuses a %s seller with the generic message', async (_, user) => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([user]);
    await expect(assertCreatorBoxSellable(ok as never)).rejects.toThrow(
      'This box is not available'
    );
  });

  it('refuses a blocked pair with the generic message', async () => {
    activeSeller();
    mocks.blockedPairIds.mockResolvedValue([SELLER]);
    await expect(assertCreatorBoxSellable(ok as never)).rejects.toThrow(
      'This box is not available'
    );
  });
});

describe('sweepCreatorBoxPayouts', () => {
  const unpaid = {
    buzzTransactionId: P,
    buyerId: BUYER,
    sellerId: SELLER,
    unitAmount: 857,
    title: 'Pack',
  };

  it('pays an unrecorded sale in the colour its charge was debited from', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([unpaid]);
    mocks.listMultiTx.mockResolvedValue([
      {
        transactionId: 'debit',
        externalTransactionId: `${P}-green`,
        accountId: BUYER,
        accountType: 'green',
      },
    ]);

    const result = await sweepCreatorBoxPayouts();

    expect(result).toMatchObject({ found: 1, paid: 1, failed: [] });
    expect(mocks.createTx.mock.calls[0][0]).toMatchObject({
      toAccountType: 'green',
      amount: 599,
      externalTransactionId: `${P}:sell:${SELLER}:green`,
    });
  });

  it('leaves a sale charged from two accounts for a person, paying nothing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([unpaid]);
    mocks.listMultiTx.mockResolvedValue([
      {
        transactionId: 'a',
        externalTransactionId: `${P}-green`,
        accountId: BUYER,
        accountType: 'green',
      },
      {
        transactionId: 'b',
        externalTransactionId: `${P}-yellow`,
        accountId: BUYER,
        accountType: 'yellow',
      },
    ]);

    const result = await sweepCreatorBoxPayouts();

    expect(result.paid).toBe(0);
    expect(result.failed).toEqual([
      { buzzTransactionId: P, error: expect.stringContaining('2 account types') },
    ]);
    expect(mocks.createTx).not.toHaveBeenCalled();
  });
});
