import { TRPCError } from '@trpc/server';
import { BuzzApiError } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';

const refundMultiAccountTransaction = vi.fn();
const getMultiAccountTransactionsByPrefix = vi.fn();
const getTransactionByExternalId = vi.fn();
const refundTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
  refundTransaction,
}));

const { getPrefixRefundState, refundAllLegsByPrefix, refundTransactionOnce } = await import(
  '~/server/services/buzz-prefix-refund'
);

const PREFIX = 'challenge-entry-fee-7-';
const input = {
  externalTransactionIdPrefix: PREFIX,
  description: 'Challenge cancelled — entry fee refund',
  details: { challengeId: 7 },
};

const leg = (transactionId: string, amount: number) => ({
  transactionId,
  externalTransactionId: `${PREFIX}${transactionId}`,
  accountType: 'yellow',
  accountId: 100,
  amount,
});
const LEGS = [leg('tx-a', 25), leg('tx-b', 40), leg('tx-c', 10)];

// What the app's mapError throws: the status survives only as `cause`.
const mapped = (status: number) =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'ledger', cause: new BuzzApiError(status, 'x') });

/** The refunds that already exist, keyed the way the ledger keys them. */
function refundsExistFor(...transactionIds: string[]) {
  getTransactionByExternalId.mockImplementation(async (externalId: string) =>
    transactionIds.map((id) => `refund-${id}`).includes(externalId) ? { type: 'Refund' } : null
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  getMultiAccountTransactionsByPrefix.mockResolvedValue(LEGS);
  refundsExistFor();
  refundTransaction.mockResolvedValue({ transactionId: 'ok' });
});

describe('refundAllLegsByPrefix', () => {
  it('reports the Buzz the prefix refund returned, not its leg count', async () => {
    refundMultiAccountTransaction.mockResolvedValue({
      refundedTransactions: [{ amount: 25 }, { amount: 40 }],
      totalRefunded: 2,
    });

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 2,
      refundedAmount: 65,
      alreadyRefundedLegs: 0,
    });
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(input);
    expect(getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
  });

  it('returns zeros for a prefix that matches nothing', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(404, 'Not Found'));

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 0,
      refundedAmount: 0,
      alreadyRefundedLegs: 0,
    });
    expect(getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
  });

  it('on a 409 with every leg already refunded, moves nothing and reports them settled', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundsExistFor('tx-a', 'tx-b', 'tx-c');

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 0,
      refundedAmount: 0,
      alreadyRefundedLegs: 3,
    });
    expect(getMultiAccountTransactionsByPrefix).toHaveBeenCalledWith(PREFIX);
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it('on a 409 after a partial refund, refunds exactly the legs still missing one', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundsExistFor('tx-b');

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 2,
      refundedAmount: 35,
      alreadyRefundedLegs: 1,
    });
    expect(refundTransaction.mock.calls).toEqual([
      ['tx-a', input.description, input.details],
      ['tx-c', input.description, input.details],
    ]);
  });

  it('reconciles a mapped 409 the same way, without reading its body', async () => {
    refundMultiAccountTransaction.mockRejectedValue(mapped(409));
    refundsExistFor('tx-a', 'tx-c');

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 1,
      refundedAmount: 40,
      alreadyRefundedLegs: 2,
    });
    expect(refundTransaction.mock.calls).toEqual([['tx-b', input.description, input.details]]);
  });

  it('counts a leg another attempt refunded between the lookup and the refund as settled', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundsExistFor('tx-a', 'tx-b');
    refundTransaction.mockImplementation(async (transactionId: string) => {
      refundsExistFor('tx-a', 'tx-b', transactionId);
      throw mapped(409);
    });

    await expect(refundAllLegsByPrefix(input)).resolves.toEqual({
      refundedLegs: 0,
      refundedAmount: 0,
      alreadyRefundedLegs: 3,
    });
  });

  it('throws when a leg refund is refused as a conflict but no refund is on the ledger', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundsExistFor('tx-a', 'tx-b');
    refundTransaction.mockRejectedValue(mapped(409));

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(
      /left 1 of 3 transactions unreversed \(tx-c: /
    );
  });

  it('throws when a leg refund is refused and its refund lookup fails, after trying the others', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'tx-a') throw mapped(409);
      return { transactionId };
    });
    // No leg is refunded yet; the read of tx-a's refund after its 409 is the one that fails.
    let txaReads = 0;
    getTransactionByExternalId.mockImplementation(async (externalId: string) => {
      if (externalId === 'refund-tx-a' && ++txaReads > 1) throw new Error('ledger down');
      return null;
    });

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(
      /left 1 of 3 transactions unreversed \(tx-a: ledger, and its refund lookup failed: ledger down\)/
    );
    expect(refundTransaction.mock.calls.map(([id]) => id)).toEqual(['tx-a', 'tx-b', 'tx-c']);
  });

  it('throws when a missing leg cannot be refunded, after trying the others', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    refundTransaction.mockImplementation(async (transactionId: string) => {
      if (transactionId === 'tx-a') throw new BuzzApiError(500, 'Internal Server Error');
      return { transactionId };
    });

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(
      /left 1 of 3 transactions unreversed \(tx-a: /
    );
    expect(refundTransaction.mock.calls.map(([id]) => id)).toEqual(['tx-a', 'tx-b', 'tx-c']);
  });

  it('throws on a 409 when the ledger lists no transactions under the prefix', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    getMultiAccountTransactionsByPrefix.mockResolvedValue([]);

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(/lists no transactions/);
  });

  it('rethrows any other failure without reconciling', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(500, 'boom'));

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(/500/);
    expect(getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
  });
});

describe('getPrefixRefundState', () => {
  it('splits the legs by whether each has its refund, and pays nothing', async () => {
    refundsExistFor('tx-b');

    await expect(getPrefixRefundState(PREFIX)).resolves.toEqual({
      reversed: [LEGS[1]],
      missing: [LEGS[0], LEGS[2]],
    });
    expect(getTransactionByExternalId.mock.calls.map(([id]) => id)).toEqual([
      'refund-tx-a',
      'refund-tx-b',
      'refund-tx-c',
    ]);
    expect(refundTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  // A caller reading inside an auto-renewing lock (creator services) needs both reads to end.
  it('passes read options to the listing and to every refund lookup', async () => {
    const opts = { timeoutMs: 1234 };
    await getPrefixRefundState(PREFIX, opts);
    expect(getMultiAccountTransactionsByPrefix).toHaveBeenCalledWith(PREFIX, opts);
    expect(getTransactionByExternalId).toHaveBeenCalledTimes(LEGS.length);
    for (const call of getTransactionByExternalId.mock.calls) expect(call[1]).toBe(opts);
  });

  it('pays no leg when a refund lookup fails', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));
    getTransactionByExternalId.mockImplementation(async (externalId: string) => {
      if (externalId === 'refund-tx-c') throw new BuzzApiError(503, 'Service Unavailable');
      return null;
    });

    await expect(refundAllLegsByPrefix(input)).rejects.toThrow(/503/);
    expect(refundTransaction).not.toHaveBeenCalled();
  });
});

describe('refundTransactionOnce', () => {
  it('returns what Buzz returned for a refund it made (or a repeat it answers 200, as today)', async () => {
    refundTransaction.mockResolvedValue({ transactionId: 'tx-a' });

    await expect(refundTransactionOnce('tx-a', 'why', { k: 1 })).resolves.toEqual({
      transactionId: 'tx-a',
    });
    expect(refundTransaction).toHaveBeenCalledWith('tx-a', 'why', { k: 1 });
    expect(getTransactionByExternalId).not.toHaveBeenCalled();
  });

  it.each([
    ['mapped', () => mapped(409)],
    ['raw', () => new BuzzApiError(409, 'Conflict')],
  ])('treats a 409 (%s) as done when the refund is on the ledger', async (_, error) => {
    refundTransaction.mockRejectedValue(error());
    refundsExistFor('tx-a');

    await expect(refundTransactionOnce('tx-a')).resolves.toEqual({ transactionId: 'tx-a' });
    expect(getTransactionByExternalId).toHaveBeenCalledWith('refund-tx-a');
  });

  it('rethrows a 409 when no refund of this transaction is on the ledger', async () => {
    const error = mapped(409);
    refundTransaction.mockRejectedValue(error);
    refundsExistFor('tx-other');

    await expect(refundTransactionOnce('tx-a')).rejects.toBe(error);
  });

  it('throws when the ledger cannot be read after a 409', async () => {
    refundTransaction.mockRejectedValue(mapped(409));
    getTransactionByExternalId.mockRejectedValue(new Error('ledger down'));

    await expect(refundTransactionOnce('tx-a')).rejects.toThrow('ledger down');
  });

  it.each([400, 404, 500])('rethrows a %s without reading the ledger', async (status) => {
    const error = mapped(status);
    refundTransaction.mockRejectedValue(error);
    refundsExistFor('tx-a');

    await expect(refundTransactionOnce('tx-a')).rejects.toBe(error);
    expect(getTransactionByExternalId).not.toHaveBeenCalled();
  });
});
