import { describe, expect, it, vi } from 'vitest';
import { BuzzApiError } from '@civitai/buzz';
import { BuzzRejectedError, buzzPort } from './buzz';

const grant = { userId: 7, amount: 12, externalTransactionId: 'key-1', description: 'd' };

describe('buzzPort', () => {
  it('grants Yellow Buzz from the bank under the conversion key', async () => {
    const createTransaction = vi
      .fn()
      .mockResolvedValue({ transactionId: 'tx-9', remainingBalance: null });

    expect(await buzzPort({ createTransaction }).grantYellow(grant)).toEqual({
      transactionId: 'tx-9',
    });

    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: 7,
        toAccountType: 'yellow',
        amount: 12,
        externalTransactionId: 'key-1',
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it('reads a duplicate key as already paid', async () => {
    const createTransaction = vi.fn().mockRejectedValue(new BuzzApiError(409, 'Conflict'));

    expect(await buzzPort({ createTransaction }).grantYellow(grant)).toEqual({
      transactionId: null,
    });
  });

  it('reports a 4xx refusal as definitive', async () => {
    const createTransaction = vi.fn().mockRejectedValue(new BuzzApiError(400, 'Bad Request'));

    await expect(buzzPort({ createTransaction }).grantYellow(grant)).rejects.toBeInstanceOf(
      BuzzRejectedError
    );
  });

  it.each([408, 429, 500, 503])('leaves a %i as an unknown outcome', async (status) => {
    const createTransaction = vi.fn().mockRejectedValue(new BuzzApiError(status, 'x'));

    const outcome = buzzPort({ createTransaction }).grantYellow(grant);

    await expect(outcome).rejects.toThrow(String(status));
    await expect(outcome).rejects.not.toBeInstanceOf(BuzzRejectedError);
  });

  it('lets any other failure through', async () => {
    const createTransaction = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(buzzPort({ createTransaction }).grantYellow(grant)).rejects.toThrow(
      'fetch failed'
    );
  });
});
