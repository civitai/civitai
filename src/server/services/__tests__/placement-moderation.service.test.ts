import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as Hooks from '~/server/events/points/hooks';

const queryRaw = dbMock.dbWrite.$queryRaw;
const settlePlacement = vi.fn();
const placementFindMany = dbMock.dbWrite.placement.findMany;
const placementFindUnique = dbMock.dbWrite.placement.findUnique;
const placementUpdateMany = dbMock.dbWrite.placement.updateMany;
const placementCount = dbMock.dbWrite.placement.count;
const suspensionFindUnique = dbMock.dbWrite.placementSuspension.findUnique;
const suspensionUpsert = dbMock.dbWrite.placementSuspension.upsert;

vi.mock('~/server/services/placement-escrow.service', () => ({ settlePlacement }));
// Asserted on, not executed: its own behaviour is tested in
// storyline-chapter-removal.service.test.ts.
const tombstoneChaptersForPlacements = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('~/server/services/storyline-chapter-removal.service', () => ({
  tombstoneChaptersForPlacements,
}));
// Asserted on, not executed: its own behaviour is tested in storyline-continuation-loop.test.ts.
const settleOrphanedContinuations = vi.fn(async (..._a: unknown[]) => ({
  considered: 0,
  settled: 0,
}));
vi.mock('~/server/services/storyline-placement.service', () => ({
  settleOrphanedContinuations,
}));
// The event points hook, so each takedown path can be seen handing its ids over. The hook's own
// behaviour is tested in src/server/events/points/__tests__/hooks.test.ts.
const onPlacementsTakenDown = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof Hooks>()),
  onPlacementsTakenDown,
}));

const {
  assertCanPlace,
  countPendingPlacementsFrom,
  declinePlacementsOnBlock,
  isPlacementBlocked,
  removePlacementByModerator,
  removePlacementsByCosmetic,
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
  placementFindUnique.mockResolvedValue(null);
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
  beforeEach(() => queryRaw.mockResolvedValue([{ exists: true }]));

  it('declines every pending placement from that user, fee waived', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await declinePlacementsOnBlock({
      ownerId: OWNER,
      placerId: PLACER,
      waiveFee: true,
    });

    expect(result).toMatchObject({ considered: 3, settled: 3 });
    for (const call of settlePlacement.mock.calls)
      expect(call[0]).toMatchObject({ action: 'declineByBlock', actorId: OWNER });
  });

  // A mass block is one action. Charging a fee per declined submission would make
  // it a way to collect N fees in a click, which the spec's "social pressure"
  // mitigation cannot reach — the blocked can no longer compare notes.
  it('never declines through the fee-charging path', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);

    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, waiveFee: true });

    expect(settlePlacement).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'decline' })
    );
  });

  // The same cascade also runs the other way: the blocker's own pending
  // placements on the person they blocked. Waiving there would hand a placer a
  // free, repeatable cancel — place, let the owner start reviewing, block, get
  // everything back, unblock, repeat. The owner spent the attention either way.
  it('charges the fee when the blocker is the one who placed', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);

    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, waiveFee: false });

    expect(settlePlacement).toHaveBeenCalledWith(expect.objectContaining({ action: 'decline' }));
    expect(settlePlacement).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'declineByBlock' })
    );
  });

  it('leaves approved placements alone, because a block is not retroactive', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }]);

    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, waiveFee: true });

    expect(placementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'pending' }) })
    );
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('keeps going when one placement fails, and reports which', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    settlePlacement.mockRejectedValueOnce(new Error('buzz service down'));

    const result = await declinePlacementsOnBlock({
      ownerId: OWNER,
      placerId: PLACER,
      waiveFee: true,
    });

    expect(result).toMatchObject({ considered: 3, settled: 2, failed: [1] });
  });

  it('bounds the batch', async () => {
    await declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, waiveFee: true, limit: 50 });
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
  beforeEach(() => suspensionFindUnique.mockResolvedValue({ userId: PLACER }));

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

describe('the preconditions the cascades depend on', () => {
  // Each cascade's correctness argument is that nothing new can join the set
  // behind it. That holds only once the block or suspension is committed, and
  // neither is written by this module — so a precondition a comment relies on is
  // a line of code.
  it('refuses to decline placements before the block is committed', async () => {
    queryRaw.mockResolvedValue([{ exists: false }]);

    await expect(
      declinePlacementsOnBlock({ ownerId: OWNER, placerId: PLACER, waiveFee: true })
    ).rejects.toThrow(/block must be committed/);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('refuses to remove placements before the user is suspended', async () => {
    suspensionFindUnique.mockResolvedValue(null);

    await expect(removePlacementsByUser({ placerId: PLACER, actorId: 99 })).rejects.toThrow(
      /suspend the user/
    );
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });
});

describe('the takedown record', () => {
  beforeEach(() => suspensionFindUnique.mockResolvedValue({ userId: PLACER }));

  // resolvedAt/resolvedById record who approved the placement. Overwriting them
  // on the one path whose purpose is a moderation record destroys the trail.
  it('keeps the approval trail intact', async () => {
    placementFindMany.mockResolvedValue([]);
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    const data = placementUpdateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ takenDownById: 99 });
    expect(data).not.toHaveProperty('resolvedById');
    expect(data).not.toHaveProperty('resolvedAt');
  });

  // updateMany cannot take a limit, so an unbounded one is a single enormous
  // UPDATE that a statement timeout rolls back whole and every retry redoes.
  it('bounds the takedown through an id list and says whether more remain', async () => {
    placementFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    placementUpdateMany.mockResolvedValue({ count: 2 });

    const result = await removePlacementsByUser({ placerId: PLACER, actorId: 99, limit: 2 });

    expect(placementUpdateMany.mock.calls[0][0].where).toMatchObject({ id: { in: [1, 2] } });
    expect(result.hasMore).toBe(true);
  });
});

describe('removing one reported placement', () => {
  const APPROVED_PLACEMENT = 3101;
  const PENDING_PLACEMENT = 3102;
  const MODERATOR = 47;

  // settlePlacement claims its transition with WHERE status = 'pending', so an
  // approved row matches nothing and it returns settled: false having moved no
  // money. Routing a live placement through it is a remove button that does
  // nothing — and a green settlePlacement mock is exactly what would hide that,
  // so this asserts the takedown write instead.
  it('takes a live placement down directly rather than through settlement', async () => {
    placementFindUnique.mockResolvedValue({ id: APPROVED_PLACEMENT, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    const result = await removePlacementByModerator({
      placementId: APPROVED_PLACEMENT,
      actorId: MODERATOR,
    });

    expect(settlePlacement).not.toHaveBeenCalled();
    expect(placementUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: APPROVED_PLACEMENT, status: 'approved' },
      data: { status: 'removed', removedBy: 'moderator', takenDownById: MODERATOR },
    });
    expect(result).toMatchObject({ removed: true, wasLive: true });
  });

  it('settles a pending placement so its escrow is forfeited', async () => {
    placementFindUnique.mockResolvedValue({ id: PENDING_PLACEMENT, status: 'pending' });

    const result = await removePlacementByModerator({
      placementId: PENDING_PLACEMENT,
      actorId: MODERATOR,
    });

    expect(placementUpdateMany).not.toHaveBeenCalled();
    expect(settlePlacement.mock.calls[0][0]).toMatchObject({
      placementId: PENDING_PLACEMENT,
      action: 'removeByModerator',
      actorId: MODERATOR,
    });
    expect(result).toMatchObject({ removed: true, wasLive: false });
  });

  it('refuses one that is already settled instead of writing over the record', async () => {
    placementFindUnique.mockResolvedValue({ id: APPROVED_PLACEMENT, status: 'declined' });

    await expect(
      removePlacementByModerator({ placementId: APPROVED_PLACEMENT, actorId: MODERATOR })
    ).rejects.toThrow(/already declined/);

    expect(placementUpdateMany).not.toHaveBeenCalled();
    expect(settlePlacement).not.toHaveBeenCalled();
  });
});

describe('removing every placement made with a revoked cosmetic', () => {
  const COSMETIC = 8801;
  const PACK_MEMBER = 8802;
  const MODERATOR = 53;

  // Index-independent: the query composes optional fragments, so asserting a
  // positional argument would quietly point at the wrong value the moment the
  // SQL gains one. A `Prisma.Sql` fragment carries its own `strings`/`values`.
  const hasFragment = (arg: unknown): arg is { strings: string[]; values: unknown[] } =>
    !!arg && typeof arg === 'object' && 'strings' in (arg as object);

  const rawValues = (call: unknown[]) =>
    call.flatMap((arg) => (hasFragment(arg) ? arg.values : [arg]));

  // The bound values alone say nothing about the predicate they are bound to:
  // swapping `"placerId"` for `"ownerId"` would keep every value assertion
  // green while removing placements ON the wrong people's content.
  const rawSql = (call: unknown[]) => {
    const parts = [...(call[0] as string[])];
    for (const arg of call.slice(1)) if (hasFragment(arg)) parts.push(...arg.strings);
    return parts.join(' ');
  };

  const rows = (pending: number[], approved: number[]) =>
    queryRaw
      .mockResolvedValueOnce(pending.map((id) => ({ id })))
      .mockResolvedValueOnce(approved.map((id) => ({ id })));

  // The content owner did not choose this sticker and was already paid for it,
  // so a live placement is taken down without settlement. Settling it would
  // compute a payout plan and claw that money back off the wrong person.
  it('takes live placements down without moving money', async () => {
    rows([], [4401, 4402]);
    placementUpdateMany.mockResolvedValue({ count: 2 });

    const result = await removePlacementsByCosmetic({
      cosmeticIds: [COSMETIC],
      actorId: MODERATOR,
    });

    expect(settlePlacement).not.toHaveBeenCalled();
    expect(placementUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: [4401, 4402] } },
      // Not 'moderator'. A reconcile has to be able to tell this from a
      // moderator removing an abusive placer's sticker, which forfeits instead
      // of refunding — and the live rows are most of a takedown, so recording
      // them as 'moderator' would leave the new reason written nowhere.
      data: { status: 'removed', removedBy: 'cosmeticTakedown', takenDownById: MODERATOR },
    });
    expect(result.takenDown).toBe(2);
  });

  // The placer is a holder of the revoked cosmetic and is refunded for it
  // everywhere else, so forfeiting their escrow here would punish them for the
  // maker's abuse. Its own action rather than removeByOwner, which pays the same
  // and would record a moderator's takedown as the owner's doing.
  it('refunds a pending placement in full rather than forfeiting it', async () => {
    rows([4403], []);
    placementUpdateMany.mockResolvedValue({ count: 0 });

    await removePlacementsByCosmetic({ cosmeticIds: [COSMETIC], actorId: MODERATOR });

    expect(settlePlacement.mock.calls[0][0]).toMatchObject({
      placementId: 4403,
      action: 'removeByCosmeticTakedown',
      actorId: MODERATOR,
    });
  });

  // A takedown that stopped after one bounded batch would report success with
  // the artwork still on other people's work.
  it('says when a batch filled so the caller runs again', async () => {
    rows([4404, 4405], []);
    placementUpdateMany.mockResolvedValue({ count: 0 });

    const result = await removePlacementsByCosmetic({
      cosmeticIds: [COSMETIC, PACK_MEMBER],
      actorId: MODERATOR,
      limit: 2,
    });

    expect(result.hasMore).toBe(true);
  });

  // Scoping this to the placers whose holding was revoked was tried and undone.
  // `UserCosmetic`'s key is [userId, cosmeticId, claimKey], so a pack's claim
  // keys miss every holding obtained another way — above all the maker's own
  // creator grant, which would leave the abusive artwork up on everything its
  // author placed it on. The sweep follows the artwork, not the placer.
  it('does not narrow the sweep by who placed it', async () => {
    rows([], [4406]);
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await removePlacementsByCosmetic({
      cosmeticIds: [COSMETIC, PACK_MEMBER],
      actorId: MODERATOR,
    });

    expect(rawSql(queryRaw.mock.calls[0])).not.toContain('placerId');
  });

  // ORDER BY id is stable, so a row that cannot settle is picked first by every
  // later batch and the drain burns its whole budget re-trying it.
  it('excludes rows an earlier batch could not settle', async () => {
    rows([], []);
    placementUpdateMany.mockResolvedValue({ count: 0 });

    await removePlacementsByCosmetic({
      cosmeticIds: [COSMETIC],
      skipIds: [4407, 4408],
      actorId: MODERATOR,
    });

    expect(rawValues(queryRaw.mock.calls[0])).toContainEqual([4407, 4408]);
    expect(rawSql(queryRaw.mock.calls[0])).toContain('NOT (id = ANY');
  });

  it('does nothing at all with no cosmetics to act on', async () => {
    const result = await removePlacementsByCosmetic({ cosmeticIds: [], actorId: MODERATOR });

    expect(queryRaw).not.toHaveBeenCalled();
    expect(placementUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ considered: 0, takenDown: 0, hasMore: false });
  });
});

describe('event points on a takedown', () => {
  it('hands a moderator takedown of a live placement to the points hook', async () => {
    placementFindUnique.mockResolvedValue({ id: 3101, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 1 });

    await removePlacementByModerator({ placementId: 3101, actorId: 47 });

    expect(onPlacementsTakenDown).toHaveBeenCalledTimes(1);
    expect(onPlacementsTakenDown).toHaveBeenCalledWith([3101]);
  });

  it('hands nothing over when the takedown lost a race', async () => {
    placementFindUnique.mockResolvedValue({ id: 3101, status: 'approved' });
    placementUpdateMany.mockResolvedValue({ count: 0 });

    await removePlacementByModerator({ placementId: 3101, actorId: 47 });

    expect(onPlacementsTakenDown).not.toHaveBeenCalled();
  });

  it("hands over a suspended placer's live placements", async () => {
    suspensionFindUnique.mockResolvedValue({ userId: PLACER });
    placementFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 7 }, { id: 8 }]);
    placementUpdateMany.mockResolvedValue({ count: 2 });

    await removePlacementsByUser({ placerId: PLACER, actorId: 99 });

    expect(onPlacementsTakenDown).toHaveBeenCalledTimes(1);
    expect(onPlacementsTakenDown).toHaveBeenCalledWith([7, 8]);
  });

  it("hands over a revoked cosmetic's live placements", async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 4401 }, { id: 4402 }]);
    placementUpdateMany.mockResolvedValue({ count: 2 });

    await removePlacementsByCosmetic({ cosmeticIds: [8801], actorId: 47 });

    expect(onPlacementsTakenDown).toHaveBeenCalledTimes(1);
    expect(onPlacementsTakenDown).toHaveBeenCalledWith([4401, 4402]);
  });
});

describe('a storyline chapter taken down with its placement', () => {
  const STORYLINE_PLACEMENT = 5501;
  const MODERATOR = 61;

  /**
   * The transaction gets its own client with its own `placement.updateMany`, defined rather than
   * assigned (`dbWrite` is a proxy whose set trap would take an assignment onto the global client),
   * so a takedown or tombstone written outside the transaction is told apart.
   */
  const txUpdateMany = vi.fn();
  let tx: object;
  const defaultTransaction = dbMock.dbWrite.$transaction.getMockImplementation();
  beforeEach(() => {
    suspensionFindUnique.mockResolvedValue({ userId: PLACER });
    txUpdateMany.mockReset();
    txUpdateMany.mockResolvedValue({ count: 1 });
    tombstoneChaptersForPlacements.mockReset();
    tombstoneChaptersForPlacements.mockResolvedValue(1);
    tx = Object.create(dbMock.dbWrite);
    Object.defineProperty(tx, 'placement', { value: { updateMany: txUpdateMany } });
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: object) => unknown) =>
      fn(tx)
    );
  });
  afterEach(() => {
    dbMock.dbWrite.$transaction.mockImplementation(defaultTransaction!);
  });

  it('tombstones the chapter of a reported approved placement, in the takedown transaction', async () => {
    placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'approved' });

    const result = await removePlacementByModerator({
      placementId: STORYLINE_PLACEMENT,
      actorId: MODERATOR,
    });

    expect(result).toMatchObject({ removed: true, wasLive: true });
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(placementUpdateMany).not.toHaveBeenCalled();
    expect(tombstoneChaptersForPlacements.mock.calls).toEqual([
      [{ placementIds: [STORYLINE_PLACEMENT] }, tx],
    ]);
    expect(tombstoneChaptersForPlacements.mock.calls[0][1]).not.toBe(dbMock.dbWrite);
  });

  it("tombstones the chapters of a suspended placer's approved placements, in the takedown transaction", async () => {
    placementFindMany
      .mockResolvedValueOnce([]) // pending
      .mockResolvedValueOnce([{ id: STORYLINE_PLACEMENT }, { id: 5502 }]); // approved
    txUpdateMany.mockResolvedValue({ count: 2 });

    const result = await removePlacementsByUser({ placerId: PLACER, actorId: MODERATOR });

    expect(result.takenDown).toBe(2);
    expect(txUpdateMany.mock.calls[0][0].where).toEqual({
      id: { in: [STORYLINE_PLACEMENT, 5502] },
      status: 'approved',
    });
    expect(placementUpdateMany).not.toHaveBeenCalled();
    expect(tombstoneChaptersForPlacements.mock.calls).toEqual([
      [{ placementIds: [STORYLINE_PLACEMENT, 5502] }, tx],
    ]);
  });

  // A refused tombstone fails the takedown with it: in Postgres the transaction
  // rolls the status flip back, so the placement and its chapter never disagree.
  it.each([
    [
      'a reported placement',
      () => {
        placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'approved' });
        return removePlacementByModerator({ placementId: STORYLINE_PLACEMENT, actorId: MODERATOR });
      },
    ],
    [
      "a suspended placer's placements",
      () => {
        placementFindMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: STORYLINE_PLACEMENT }]);
        return removePlacementsByUser({ placerId: PLACER, actorId: MODERATOR });
      },
    ],
  ])('fails the takedown of %s when the tombstone fails, and awards no points', async (_, run) => {
    tombstoneChaptersForPlacements.mockRejectedValue(new Error('lock timeout'));

    await expect(run()).rejects.toThrow('lock timeout');
    expect(onPlacementsTakenDown).not.toHaveBeenCalled();
  });

  // The tombstone is asked for every id given, whatever the flip matched (here,
  // a row another takedown flipped between the read and this write).
  it('still asks for the tombstone when the takedown flips nothing', async () => {
    placementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: STORYLINE_PLACEMENT }]);
    txUpdateMany.mockResolvedValue({ count: 0 });

    await removePlacementsByUser({ placerId: PLACER, actorId: MODERATOR });

    expect(tombstoneChaptersForPlacements).toHaveBeenCalledWith(
      { placementIds: [STORYLINE_PLACEMENT] },
      tx
    );
  });

  describe('the continuations of a removed chapter', () => {
    // Settling moves Buzz, so it runs after the takedown commits, never inside it.
    it.each([
      [
        'a reported placement',
        () => {
          placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'approved' });
          return removePlacementByModerator({
            placementId: STORYLINE_PLACEMENT,
            actorId: MODERATOR,
          });
        },
        [STORYLINE_PLACEMENT],
      ],
      [
        "a suspended placer's placements",
        () => {
          placementFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: STORYLINE_PLACEMENT }, { id: 5502 }]);
          return removePlacementsByUser({ placerId: PLACER, actorId: MODERATOR });
        },
        [STORYLINE_PLACEMENT, 5502],
      ],
    ])('are settled after the takedown of %s commits', async (_, run, ids) => {
      const events: string[] = [];
      tombstoneChaptersForPlacements.mockImplementation(async () => {
        events.push('tombstone');
        return 1;
      });
      dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: object) => unknown) => {
        const result = await fn(tx);
        events.push('commit');
        return result;
      });
      settleOrphanedContinuations.mockImplementation(async () => {
        events.push('settle');
        return { considered: 0, settled: 0 };
      });

      await run();

      expect(events).toEqual(['tombstone', 'commit', 'settle']);
      expect(settleOrphanedContinuations.mock.calls).toEqual([[{ removedPlacementIds: ids }]]);
    });

    // The takedown has happened; the orphaned-continuation job settles what this left.
    it('does not fail the takedown when settling them fails', async () => {
      placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'approved' });
      settleOrphanedContinuations.mockRejectedValueOnce(new Error('buzz down'));

      await expect(
        removePlacementByModerator({ placementId: STORYLINE_PLACEMENT, actorId: MODERATOR })
      ).resolves.toMatchObject({ removed: true });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'buzz down', placementIds: [STORYLINE_PLACEMENT] })
      );
    });

    it('are settled again when a removed placement is removed again, which still refuses', async () => {
      placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'removed' });

      await expect(
        removePlacementByModerator({ placementId: STORYLINE_PLACEMENT, actorId: MODERATOR })
      ).rejects.toThrow('already removed');
      expect(settleOrphanedContinuations).toHaveBeenCalledWith({
        removedPlacementIds: [STORYLINE_PLACEMENT],
      });
    });

    it('are not settled when the tombstone fails, since nothing was removed', async () => {
      placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'approved' });
      tombstoneChaptersForPlacements.mockRejectedValue(new Error('lock timeout'));

      await expect(
        removePlacementByModerator({ placementId: STORYLINE_PLACEMENT, actorId: MODERATOR })
      ).rejects.toThrow('lock timeout');
      expect(settleOrphanedContinuations).not.toHaveBeenCalled();
    });
  });

  // Pending placements have no chapter: they settle through the ordinary path,
  // which writes none.
  it('asks for no tombstone when removing a pending placement', async () => {
    placementFindUnique.mockResolvedValue({ id: STORYLINE_PLACEMENT, status: 'pending' });

    await removePlacementByModerator({ placementId: STORYLINE_PLACEMENT, actorId: MODERATOR });

    expect(tombstoneChaptersForPlacements).not.toHaveBeenCalled();
  });
});
