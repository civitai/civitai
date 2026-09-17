import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzApiError } from '@civitai/buzz';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const findUnique = dbMock.dbRead.crucible.findUnique;
const update = dbMock.dbWrite.crucible.update;
const refundMultiAccountTransaction = vi.fn();
const setTTL = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  refundMultiAccountTransaction,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { setTTL },
}));

const {
  cancelCrucible,
  getCrucibleSetupTransactionPrefix,
  getCrucibleSeedTransactionPrefix,
  getCrucibleEntryTransactionPrefix,
  isCrucibleEntryTransactionPrefix,
} = await import('~/server/services/crucible.service');

const entry = (id: number, userId: number, buzzTransactionId: string | null) => ({
  id,
  userId,
  buzzTransactionId,
});

const crucible = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  userId: 4,
  status: CrucibleStatus.Active,
  entryFee: 100,
  buzzTransactionId: 'crucible-setup-4-abc',
  seededPrizePool: 0,
  seedTransactionId: null,
  entries: [entry(1, 10, 'entry-1-10'), entry(2, 11, 'entry-2-11')],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(crucible());
  update.mockResolvedValue({});
  setTTL.mockResolvedValue(undefined);
  refundMultiAccountTransaction.mockResolvedValue(undefined);
});

describe('cancelCrucible — authorization', () => {
  it('refuses a non-moderator', async () => {
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: false })).rejects.toThrow();
  });

  it('refuses a non-moderator before reading anything, so it cannot leak the crucible', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: false }).catch(() => undefined);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refunds nothing when authorization fails', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: false }).catch(() => undefined);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('cancelCrucible — state guards', () => {
  it('throws when the crucible does not exist', async () => {
    findUnique.mockResolvedValue(null);
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow();
  });

  it('refuses to cancel a Completed crucible', async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow();
  });

  it('does not refund a completed crucible — its prizes are already paid out', async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));
    await cancelCrucible({ id: 1, userId: 4, isModerator: true }).catch(() => undefined);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('re-runs on an already-Cancelled crucible instead of refusing, so owed refunds can retry', async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Cancelled }));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.crucibleId).toBe(1);
    expect(refundMultiAccountTransaction).toHaveBeenCalled();
  });
});

describe('cancelCrucible — ordering', () => {
  it('writes the Cancelled status before any money moves', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Cancelled },
    });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      refundMultiAccountTransaction.mock.invocationCallOrder[0]
    );
  });

  it('moves no money at all when the status write fails', async () => {
    update.mockRejectedValue(new Error('Server has closed the connection'));

    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('cancelCrucible — refund idempotency', () => {
  it.each([409, 404])('treats a buzz %i as already settled, not a failed refund', async (status) => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(status, 'nope'));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.failedRefunds).toEqual([]);
    expect(result.refundedEntries).toBe(2);
  });

  // Without this the second cancel reports the same totals as the first and reads as a second
  // payment, which is the report that gets someone refunded twice by hand.
  it('counts an already-settled refund separately from one that moved money', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(409, 'Conflict'));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.alreadySettled).toBe(3); // 2 entries + the creator's setup fee
  });

  it('reports nothing already settled on a first, clean cancel', async () => {
    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.alreadySettled).toBe(0);
  });

  it('still reports a genuine buzz failure', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(500, 'boom'));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.failedRefunds.length).toBeGreaterThan(0);
  });
});

describe('cancelCrucible — entry refunds', () => {
  it('refunds every entry that carries a transaction prefix', async () => {
    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.refundedEntries).toBe(2);
    expect(result.totalRefunded).toBe(200); // 2 entries x 100 entryFee
    expect(result.failedRefunds).toEqual([]);
  });

  it('skips entries with no transaction prefix rather than refunding a free entry', async () => {
    findUnique.mockResolvedValue(
      crucible({ entries: [entry(1, 10, 'entry-1-10'), entry(2, 11, null)] })
    );

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.refundedEntries).toBe(1);
    expect(result.totalRefunded).toBe(100);
    const prefixes = refundMultiAccountTransaction.mock.calls.map(
      ([arg]) => arg.externalTransactionIdPrefix
    );
    expect(prefixes).not.toContain(null);
  });

  it('reports a failed entry refund instead of throwing, so the rest still land', async () => {
    refundMultiAccountTransaction.mockImplementation(({ externalTransactionIdPrefix }) => {
      if (externalTransactionIdPrefix === 'entry-1-10') throw new Error('buzz unavailable');
      return Promise.resolve(undefined);
    });

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.refundedEntries).toBe(1);
    expect(result.totalRefunded).toBe(100);
    expect(result.failedRefunds).toEqual([{ entryId: 1, userId: 10, error: 'buzz unavailable' }]);
  });

  it('still cancels the crucible when every refund fails', async () => {
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    // Two entrants plus the creator's setup fee — crucible-level refunds carry `entryId: null`.
    expect(result.failedRefunds.filter((f) => f.entryId !== null)).toHaveLength(2);
    expect(result.failedRefunds.filter((f) => f.entryId === null)).toHaveLength(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Cancelled },
    });
  });

  it('handles a crucible with no entries', async () => {
    findUnique.mockResolvedValue(crucible({ entries: [] }));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.refundedEntries).toBe(0);
    expect(result.totalRefunded).toBe(0);
  });
});

describe('cancelCrucible — creator setup fee', () => {
  it('refunds the creator setup fee using the stored prefix', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    const prefixes = refundMultiAccountTransaction.mock.calls.map(
      ([arg]) => arg.externalTransactionIdPrefix
    );
    expect(prefixes).toContain('crucible-setup-4-abc');
  });

  it('skips the setup fee when the crucible was free to create', async () => {
    findUnique.mockResolvedValue(crucible({ buzzTransactionId: null }));

    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    const prefixes = refundMultiAccountTransaction.mock.calls.map(
      ([arg]) => arg.externalTransactionIdPrefix
    );
    expect(prefixes).not.toContain('crucible-setup-4-abc');
    expect(prefixes).toHaveLength(2); // the two entry refunds only
  });

  it('completes the cancellation even when the setup fee refund fails', async () => {
    refundMultiAccountTransaction.mockImplementation(({ externalTransactionIdPrefix }) => {
      if (externalTransactionIdPrefix === 'crucible-setup-4-abc') throw new Error('nope');
      return Promise.resolve(undefined);
    });

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.failedRefunds).toEqual([{ entryId: null, userId: 4, error: 'nope' }]);
    expect(update).toHaveBeenCalled();
  });
});

describe('cancelCrucible — seeded prize pool', () => {
  const seeded = (overrides: Record<string, unknown> = {}) =>
    crucible({ seededPrizePool: 5_000, seedTransactionId: 'crucible-seed-4-xyz', ...overrides });

  it('returns the seed to the creator using the stored prefix', async () => {
    findUnique.mockResolvedValue(seeded());

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    const prefixes = refundMultiAccountTransaction.mock.calls.map(
      ([arg]) => arg.externalTransactionIdPrefix
    );
    expect(prefixes).toContain('crucible-seed-4-xyz');
    expect(result.refundedSeed).toBe(5_000);
  });

  it('keeps the seed out of totalRefunded, which is the entrants money', async () => {
    findUnique.mockResolvedValue(seeded());

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.totalRefunded).toBe(200); // 2 entries x 100, seed excluded
  });

  it('makes no refund call at all for an unseeded crucible', async () => {
    // An unseeded crucible has no prefix to refund; the 404 tolerance must not be what covers that.
    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    const prefixes = refundMultiAccountTransaction.mock.calls.map(
      ([arg]) => arg.externalTransactionIdPrefix
    );
    expect(prefixes).toEqual(['entry-1-10', 'entry-2-11', 'crucible-setup-4-abc']);
    expect(result.refundedSeed).toBe(0);
  });

  it('completes the cancellation, reporting no seed refunded, when the seed refund fails', async () => {
    findUnique.mockResolvedValue(seeded());
    refundMultiAccountTransaction.mockImplementation(({ externalTransactionIdPrefix }) => {
      if (externalTransactionIdPrefix === 'crucible-seed-4-xyz') throw new Error('buzz down');
      return Promise.resolve(undefined);
    });

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.refundedSeed).toBe(0);
    expect(result.failedRefunds).toEqual([{ entryId: null, userId: 4, error: 'buzz down' }]);
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Cancelled },
    });
  });
});

describe('cancelCrucible — cleanup', () => {
  it('expires the Redis ELO data rather than leaving it forever', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });
    expect(setTTL).toHaveBeenCalledWith(1, 24 * 60 * 60);
  });
});

describe('transaction prefixes', () => {
  it('scopes a setup prefix to the user', () => {
    expect(getCrucibleSetupTransactionPrefix(42)).toContain('42');
  });

  it('scopes an entry prefix to both the crucible and the user', () => {
    const prefix = getCrucibleEntryTransactionPrefix(7, 42);
    expect(prefix).toContain('7');
    expect(prefix).toContain('42');
  });

  it('recognises its own entry prefixes and not the setup ones', () => {
    expect(isCrucibleEntryTransactionPrefix(getCrucibleEntryTransactionPrefix(7, 42))).toBe(true);
    expect(isCrucibleEntryTransactionPrefix(getCrucibleSetupTransactionPrefix(42))).toBe(false);
    expect(isCrucibleEntryTransactionPrefix(getCrucibleSeedTransactionPrefix(42))).toBe(false);
    expect(isCrucibleEntryTransactionPrefix('something-else')).toBe(false);
  });

  it('keeps the seed prefix from prefix-matching the setup one, so refunds stay separable', () => {
    const setup = getCrucibleSetupTransactionPrefix(42);
    const seed = getCrucibleSeedTransactionPrefix(42);

    expect(seed).not.toBe(setup);
    expect(seed.startsWith(setup)).toBe(false);
    expect(setup.startsWith(seed)).toBe(false);
  });
});
