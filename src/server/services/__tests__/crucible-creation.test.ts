import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const imageCreate = dbMock.dbWrite.image.create;
const crucibleCreate = dbMock.dbWrite.crucible.create;
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));

const { createCrucible } = await import('~/server/services/crucible.service');

const input = (overrides: Record<string, unknown> = {}) => ({
  userId: 4,
  name: 'Test Crucible',
  description: 'A description',
  coverImage: { url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900', width: 512, height: 704 },
  nsfwLevel: 1,
  entryFee: 100,
  entryLimit: 1,
  maxTotalEntries: undefined,
  prizePositions: { '1': 50, '2': 30, '3': 20 },
  // duration 8 is free, so the customization fee is the whole setup cost: 1,000 Buzz.
  prizeCustomized: true,
  duration: 8,
  seededPrizePool: 0,
  ...overrides,
});

const balance = (amount: number) =>
  getUserBuzzAccount.mockResolvedValue([{ balance: amount, type: 'yellow' }]);

const chargedAmounts = () =>
  createMultiAccountBuzzTransaction.mock.calls.map(([arg]) => arg.amount);

const refundedPrefixes = () =>
  refundMultiAccountTransaction.mock.calls.map(([arg]) => arg.externalTransactionIdPrefix);

beforeEach(() => {
  vi.clearAllMocks();
  balance(1_000_000);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactions: [] });
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  imageCreate.mockResolvedValue({ id: 99 });
  crucibleCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    ...data,
  }));
});

describe('createCrucible — seeded prize pool', () => {
  it('charges the seed as its own transaction on top of the setup fee', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    expect(chargedAmounts()).toEqual([1_000, 5_000]);
  });

  it('stores the seed and the prefix that can refund it', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.seededPrizePool).toBe(5_000);
    expect(data.seedTransactionId).toMatch(/^crucible-seed-4-/);
    expect(data.seedTransactionId).not.toBe(data.buzzTransactionId);
  });

  it('stores no seed prefix when nothing was seeded', async () => {
    await createCrucible(input({ seededPrizePool: 0 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.seededPrizePool).toBe(0);
    expect(data.seedTransactionId).toBeNull();
    expect(chargedAmounts()).toEqual([1_000]);
  });
});

describe('createCrucible — the creator cannot afford the seed', () => {
  it('fails and creates no crucible', async () => {
    balance(4_000); // covers the 1,000 setup fee but not the 5,000 seed

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow();

    expect(crucibleCreate).not.toHaveBeenCalled();
  });

  it('takes no money at all, rather than charging the setup fee first and unwinding it', async () => {
    balance(4_000);

    await createCrucible(input({ seededPrizePool: 5_000 })).catch(() => undefined);

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('names the combined cost in the error, not just the setup fee', async () => {
    balance(4_000);

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow(/6,000 Buzz/);
  });
});

describe('createCrucible — a charge or write fails after money moved', () => {
  it('refunds the setup fee and creates no crucible when the seed charge fails', async () => {
    createMultiAccountBuzzTransaction.mockImplementation(async ({ amount }: { amount: number }) => {
      if (amount === 5_000) throw new Error('buzz down');
      return { transactions: [] };
    });

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('buzz down');

    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(refundedPrefixes()).toEqual([expect.stringMatching(/^crucible-setup-4-/)]);
  });

  it('refunds both the setup fee and the seed when the database write fails', async () => {
    crucibleCreate.mockRejectedValue(new Error('db down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');

    expect(refundedPrefixes()).toEqual([
      expect.stringMatching(/^crucible-setup-4-/),
      expect.stringMatching(/^crucible-seed-4-/),
    ]);
  });

  it('still surfaces the original failure when the refund itself fails', async () => {
    crucibleCreate.mockRejectedValue(new Error('db down'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('refund down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');
  });
});
