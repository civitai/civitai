import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzApiError } from '@civitai/buzz';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PostService from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const findUnique = dbMock.dbWrite.crucible.findUnique;
const claim = dbMock.dbWrite.crucible.updateMany;
const refundMultiAccountTransaction = vi.fn();
const setTTL = vi.fn();
const createNotification = vi.fn();
const afterPostsPublish = vi.fn();

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

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
  claimCrucibleCancellation,
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
  name: 'Liminal Stuff',
  ingestion: CrucibleIngestionStatus.Scanned,
  textNsfw: false,
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
  claim.mockResolvedValue({ count: 1 });
  setTTL.mockResolvedValue(undefined);
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  createNotification.mockResolvedValue(undefined);
  afterPostsPublish.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

const MODERATOR_CLAIM = {
  where: {
    id: 1,
    OR: [
      { status: CrucibleStatus.Pending },
      {
        status: CrucibleStatus.Active,
        OR: [{ endAt: null }, { endAt: { gt: expect.any(Date) } }, { entries: { none: {} } }],
      },
    ],
  },
  data: { status: CrucibleStatus.Cancelled },
};

describe('claimCrucibleCancellation', () => {
  // Past its end an Active crucible with entries is finalize's: cancelling it then would refund
  // the pool finalize pays prizes from.
  it('claims Pending, or Active only before its end or with nobody entered', async () => {
    await claimCrucibleCancellation(1);
    expect(claim).toHaveBeenCalledWith(MODERATOR_CLAIM);
  });

  it("claims only the owner's crucible, and only before it starts, for an owner", async () => {
    await claimCrucibleCancellation(1, { ownerId: 4 });
    expect(claim).toHaveBeenCalledWith({
      where: { id: 1, userId: 4, status: CrucibleStatus.Pending },
      data: { status: CrucibleStatus.Cancelled },
    });
  });

  it('reports whether it claimed', async () => {
    claim.mockResolvedValue({ count: 0 });
    await expect(claimCrucibleCancellation(1)).resolves.toBe(false);
    claim.mockResolvedValue({ count: 1 });
    await expect(claimCrucibleCancellation(1)).resolves.toBe(true);
  });
});

describe('cancelCrucible — authorization', () => {
  it('refuses someone who neither moderates nor owns it', async () => {
    claim.mockResolvedValue({ count: 0 });
    await expect(cancelCrucible({ id: 1, userId: 99, isModerator: false })).rejects.toThrow(
      /Only moderators/
    );
  });

  it('refuses the owner once the crucible has started', async () => {
    claim.mockResolvedValue({ count: 0 });
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: false })).rejects.toThrow(
      /Only moderators/
    );
  });

  it("claims through the owner's narrower predicate for a non-moderator", async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Pending, entries: [] }));

    await cancelCrucible({ id: 1, userId: 4, isModerator: false });

    expect(claim).toHaveBeenCalledWith({
      where: { id: 1, userId: 4, status: CrucibleStatus.Pending },
      data: { status: CrucibleStatus.Cancelled },
    });
  });

  it('lets the owner cancel before it starts, and returns their setup fee', async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Pending, entries: [] }));

    await cancelCrucible({ id: 1, userId: 4, isModerator: false });

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'crucible-setup-4-abc' })
    );
  });

  it('refunds nothing when authorization fails', async () => {
    claim.mockResolvedValue({ count: 0 });
    await cancelCrucible({ id: 1, userId: 99, isModerator: false }).catch(() => undefined);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('cancelCrucible — state guards', () => {
  it('throws when the crucible does not exist', async () => {
    findUnique.mockResolvedValue(null);
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow();
  });

  it('refuses to cancel a Completed crucible', async () => {
    claim.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));
    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow(
      /completed/
    );
  });

  it('does not refund a completed crucible — its prizes are already paid out', async () => {
    claim.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));
    await cancelCrucible({ id: 1, userId: 4, isModerator: true }).catch(() => undefined);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('refuses, and refunds nothing, once an Active crucible with entries has ended', async () => {
    claim.mockResolvedValue({ count: 0 });

    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow(
      /being finalized/
    );
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('re-runs on an already-Cancelled crucible instead of refusing, so owed refunds can retry', async () => {
    claim.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Cancelled }));

    const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(result.crucibleId).toBe(1);
    expect(refundMultiAccountTransaction).toHaveBeenCalled();
  });

  it('refunds the entries the primary holds after the claim', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(findUnique.mock.invocationCallOrder[0]);
    expect(dbMock.dbRead.crucible.findUnique).not.toHaveBeenCalled();
  });
});

describe('cancelCrucible — ordering', () => {
  it('claims Cancelled before any money moves', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(claim).toHaveBeenCalledWith(MODERATOR_CLAIM);
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
      refundMultiAccountTransaction.mock.invocationCallOrder[0]
    );
  });

  it('moves no money at all when the status write fails', async () => {
    claim.mockRejectedValue(new Error('Server has closed the connection'));

    await expect(cancelCrucible({ id: 1, userId: 4, isModerator: true })).rejects.toThrow();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('cancelCrucible — refund idempotency', () => {
  it.each([409, 404])(
    'treats a buzz %i as already settled, not a failed refund',
    async (status) => {
      refundMultiAccountTransaction.mockRejectedValue(new BuzzApiError(status, 'nope'));

      const result = await cancelCrucible({ id: 1, userId: 4, isModerator: true });

      expect(result.failedRefunds).toEqual([]);
      expect(result.refundedEntries).toBe(2);
    }
  );

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

  // Entries in one crucible can be paid in green and yellow. Reversing each entry's own charge is
  // what returns it in the currency it was paid in; a refund that named a currency, or pooled the
  // entries, would turn one into the other. Do not "simplify" this into a single payout.
  it('refunds each entry by reversing its own charge, naming no currency', async () => {
    findUnique.mockResolvedValue(
      crucible({ entries: [entry(1, 10, 'green-paid-1-10'), entry(2, 11, 'yellow-paid-2-11')] })
    );

    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    const entryRefunds = refundMultiAccountTransaction.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.externalTransactionIdPrefix !== 'crucible-setup-4-abc');
    expect(entryRefunds.map((arg) => arg.externalTransactionIdPrefix)).toEqual([
      'green-paid-1-10',
      'yellow-paid-2-11',
    ]);
    for (const arg of entryRefunds)
      expect(Object.keys(arg).sort()).toEqual([
        'description',
        'details',
        'externalTransactionIdPrefix',
      ]);
  });

  it('names and links the crucible on each entry refund', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'entry-1-10',
        description: 'Crucible entry fee refund - crucible cancelled: Liminal Stuff',
        details: expect.objectContaining({ entityId: 1, entityType: 'Crucible' }),
      })
    );
  });

  it('leaves a name flagged as adult text off the entry refunds', async () => {
    findUnique.mockResolvedValue(crucible({ textNsfw: true }));

    await cancelCrucible({ id: 1, userId: 4, isModerator: true });

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'entry-1-10',
        description: 'Crucible entry fee refund - crucible cancelled',
      })
    );
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
    expect(claim).toHaveBeenCalledWith(MODERATOR_CLAIM);
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
    expect(claim).toHaveBeenCalled();
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
    expect(claim).toHaveBeenCalledWith(MODERATOR_CLAIM);
  });
});

describe('cancelCrucible — cleanup', () => {
  it('expires the Redis ELO data rather than leaving it forever', async () => {
    await cancelCrucible({ id: 1, userId: 4, isModerator: true });
    expect(setTTL).toHaveBeenCalledWith(1, 24 * 60 * 60);
  });
});

describe('cancelCrucible — entrants are told', () => {
  const sent = () => createNotification.mock.calls.map(([n]) => n);

  it('tells each entrant once, not the creator, that their fees were refunded', async () => {
    findUnique.mockResolvedValue(
      crucible({
        entries: [entry(1, 10, 'entry-1-10'), entry(2, 10, 'entry-2-10'), entry(3, 11, null)],
      })
    );

    await cancelCrucible({ id: 1, userId: 3, isModerator: true });

    expect(sent()).toEqual([
      expect.objectContaining({
        type: 'crucible-cancelled',
        userIds: [10, 11],
        key: 'crucible-cancelled:1',
        details: { crucibleId: 1, crucibleName: 'Liminal Stuff', refundPending: false },
      }),
    ]);
  });

  it('tells an entrant whose refund failed that it is still being processed', async () => {
    refundMultiAccountTransaction.mockImplementation(({ externalTransactionIdPrefix }) => {
      if (externalTransactionIdPrefix === 'entry-1-10') throw new Error('buzz unavailable');
      return Promise.resolve(undefined);
    });

    await cancelCrucible({ id: 1, userId: 3, isModerator: true });

    expect(sent()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userIds: [11],
          details: expect.objectContaining({ refundPending: false }),
        }),
        expect.objectContaining({
          userIds: [10],
          key: 'crucible-cancelled-pending:1',
          details: expect.objectContaining({ refundPending: true }),
        }),
      ])
    );
  });

  it('leaves a name flagged as adult text out of the notice', async () => {
    findUnique.mockResolvedValue(crucible({ textNsfw: true }));

    await cancelCrucible({ id: 1, userId: 3, isModerator: true });

    expect(sent()[0].details.crucibleName).toBeNull();
  });

  it('sends nothing when nobody entered', async () => {
    findUnique.mockResolvedValue(crucible({ entries: [] }));

    await cancelCrucible({ id: 1, userId: 3, isModerator: true });

    expect(createNotification).not.toHaveBeenCalled();
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

describe('cancelCrucible — entry posts', () => {
  const revealQuery = () => {
    const call = dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]) =>
      (strings as string[]).join('').includes('entry_posts')
    );
    if (!call) return undefined;
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    const query = Prisma.sql(strings, ...values);
    return { sql: query.text, values: query.values };
  };

  it("publishes this crucible's still-hidden entry posts now and reindexes them", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 300, userId: 10 }]);

    await cancelCrucible({ id: 1, userId: 99, isModerator: true });

    const query = revealQuery();
    expect(query?.sql).toMatch(
      /UPDATE "Post" p SET "publishedAt" = now\(\)\s+FROM entry_posts e\s+WHERE p\.id = e\.id AND e\.hidden/
    );
    expect(query?.sql).toMatch(/ce\."crucibleId" = \$\d/);
    expect(query?.values).toEqual(expect.arrayContaining([1, 'crucibleEntryDraft']));
    expect(afterPostsPublish).toHaveBeenCalledTimes(1);
    expect(afterPostsPublish).toHaveBeenCalledWith([{ postId: 300, userId: 10 }]);
  });

  it('reveals only after every refund has been attempted', async () => {
    await cancelCrucible({ id: 1, userId: 99, isModerator: true });

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(3);
    const revealOrder = dbMock.dbWrite.$queryRaw.mock.invocationCallOrder.at(-1)!;
    for (const refundOrder of refundMultiAccountTransaction.mock.invocationCallOrder)
      expect(refundOrder).toBeLessThan(revealOrder);
  });

  it('reveals nothing when the cancel is refused', async () => {
    claim.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));

    await expect(cancelCrucible({ id: 1, userId: 99, isModerator: true })).rejects.toThrow();
    expect(revealQuery()).toBeUndefined();
  });

  it('still refunds every entry when the reveal fails', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: string[]) => {
      if (strings.join('').includes('entry_posts')) throw new Error('db down');
      return [];
    });

    const result = await cancelCrucible({ id: 1, userId: 99, isModerator: true });

    expect(result.refundedEntries).toBe(2);
  });
});
