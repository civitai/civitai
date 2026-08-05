import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();
const settlePlacement = vi.fn();
const placementFindMany = vi.fn();
const placementUpdateMany = vi.fn();
const placementCount = vi.fn();
const suspensionFindUnique = vi.fn();
const suspensionUpsert = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $queryRaw: queryRaw,
    placement: {
      findMany: placementFindMany,
      updateMany: placementUpdateMany,
      count: placementCount,
    },
    placementSuspension: {
      findUnique: suspensionFindUnique,
      upsert: suspensionUpsert,
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('~/server/services/placement-escrow.service', () => ({ settlePlacement }));

const {
  assertCanPlace,
  countPendingPlacementsFrom,
  declinePlacementsOnBlock,
  isPlacementBlocked,
  removePlacementsByUser,
  suspendPlacementPrivileges,
} = await import('~/server/services/placement-moderation.service');

const OWNER = 10;
const PLACER = 20;

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ exists: false }]);
  suspensionFindUnique.mockResolvedValue(null);
  placementFindMany.mockResolvedValue([]);
  placementUpdateMany.mockResolvedValue({ count: 0 });
  settlePlacement.mockResolvedValue({ settled: true });
});

describe('the block guard', () => {
  // getBlockedPairIds is a Redis cache over a dbRead replica. Using it here would
  // make the block a filter rather than a refusal — a block committed seconds
  // earlier would still let the placement through.
  it('reads the primary, not the block cache', async () => {
    await isPlacementBlocked({ ownerId: OWNER, placerId: PLACER });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('UserEngagement');
    expect(sql).toContain('Block');
  });

  it('is bidirectional, so neither party can place on the other', async () => {
    const sql =
      (await isPlacementBlocked({ ownerId: OWNER, placerId: PLACER }),
      queryRaw.mock.calls[0][0].join('?'));

    // Both orderings of the pair appear in the predicate.
    expect(sql.match(/"userId" =/g) ?? []).toHaveLength(2);
    expect(sql.match(/"targetUserId" =/g) ?? []).toHaveLength(2);
  });

  // Refusing is not filtering: the guard throws rather than returning a boolean
  // a caller can forget to check.
  it('refuses a blocked placement', async () => {
    queryRaw.mockResolvedValue([{ exists: true }]);

    await expect(assertCanPlace({ ownerId: OWNER, placerId: PLACER })).rejects.toThrow(
      /not available/
    );
  });

  it('refuses a suspended placer', async () => {
    suspensionFindUnique.mockResolvedValue({ userId: PLACER });

    await expect(assertCanPlace({ ownerId: OWNER, placerId: PLACER })).rejects.toThrow(/suspended/);
  });

  it('allows an unblocked, unsuspended placer', async () => {
    await expect(assertCanPlace({ ownerId: OWNER, placerId: PLACER })).resolves.toBeUndefined();
  });
});

describe('blocking cascades to pending placements', () => {
  it('declines every pending placement from that user, fee waived', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER });

    expect(result).toMatchObject({ considered: 3, settled: 3 });
    for (const call of settlePlacement.mock.calls)
      expect(call[0]).toMatchObject({ action: 'declineByBlock', actorId: OWNER });
  });

  // A mass block is one action. Charging a fee per declined submission would make
  // it a way to collect N fees in a click, which the spec's "social pressure"
  // mitigation cannot reach — the blocked can no longer compare notes.
  it('never declines through the fee-charging path', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);

    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER });

    expect(settlePlacement).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'decline' })
    );
  });

  it('leaves approved placements alone, because a block is not retroactive', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);

    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER });

    expect(placementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'pending' }) })
    );
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('keeps going when one placement fails, and reports which', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    settlePlacement.mockRejectedValueOnce(new Error('buzz service down'));

    const result = await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER });

    expect(result).toMatchObject({ considered: 3, settled: 2, failed: [1] });
  });

  it('bounds the batch', async () => {
    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, limit: 50 });
    expect(placementFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });
});

describe('the confirmation count', () => {
  it('is a plain count of what would be declined', async () => {
    placementCount.mockResolvedValue(12);

    await expect(countPendingPlacementsFrom({ ownerId: OWNER, placerId: PLACER })).resolves.toBe(
      12
    );
    expect(placementCount).toHaveBeenCalledWith({
      where: { ownerId: OWNER, placerId: PLACER, status: 'pending' },
    });
  });
});

describe('moderator removal', () => {
  // settlePlacement claims WHERE status = 'pending', so routing approved
  // placements through it would silently no-op on exactly the ones a moderator
  // most needs gone.
  it('takes down approved placements as well as pending ones', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);
    placementUpdateMany.mockResolvedValue({ count: 4 });

    const result = await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    expect(result).toMatchObject({ settled: 1, takenDown: 4 });
    expect(placementUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { placerId: PLACER, status: 'approved' },
        data: expect.objectContaining({ status: 'removed', removedBy: 'moderator' }),
      })
    );
  });

  it('forfeits pending escrow through the ordinary settle path', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    for (const call of settlePlacement.mock.calls)
      expect(call[0]).toMatchObject({ action: 'removeByModerator', actorId: 99 });
  });

  // Taking down an approved placement moves no money: it was already paid to an
  // owner who did nothing wrong. Clawing it back would punish the wrong party.
  it('moves no money when taking down an approved placement', async () => {
    placementFindMany.mockResolvedValue([]);
    placementUpdateMany.mockResolvedValue({ count: 3 });

    const result = await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    expect(settlePlacement).not.toHaveBeenCalled();
    expect(result.takenDown).toBe(3);
  });

  it('is safe to run again after a timeout', async () => {
    placementFindMany.mockResolvedValue([]);
    placementUpdateMany.mockResolvedValue({ count: 0 });

    const second = await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    expect(second).toMatchObject({ considered: 0, settled: 0, takenDown: 0 });
  });
});

describe('suspension', () => {
  it('is stored on its own, not as a block from a system account', async () => {
    await suspendPlacementPrivileges({ userId: PLACER, actorId: 99, reason: 'harassment' });

    expect(suspensionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: PLACER } })
    );
    // Nothing was written to the block table, which real users' block lists read.
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
