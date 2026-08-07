import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fixture discipline: every quantity in scope is a distinct number, so a value
 * reaching the wrong place cannot pass by colliding with the right one. Mutation
 * does not catch that class — only picking the numbers does.
 */
const OWNER = 41;
const PLACER = 52;
const SELLER = 63;
const IMAGE = 74;
const COSMETIC = 85;
const PLACEMENT = 96;
const PRICE = 700;

const holdPlacementEscrow = vi.fn();
const settlePlacement = vi.fn(async () => ({ settled: true }));
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow,
  settlePlacement,
  MAX_LEG_ATTEMPTS: 5,
}));

const assertCanPlace = vi.fn(async () => undefined);
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace }));

const resolvePlacementSpaceFor = vi.fn();
vi.mock('~/server/services/placement-space.service', () => ({ resolvePlacementSpaceFor }));

const spendStickerUsesFor = vi.fn(async () => undefined);
vi.mock('~/server/services/sticker.service', () => ({ spendStickerUsesFor }));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

/**
 * The order operations happen in is the whole design of the mutation, and it
 * cannot be read off a set of assertions about final state — so every call
 * appends here and the ordering tests read the sequence.
 */
const calls: string[] = [];

const queryRaw = vi.fn();
const placementCreate = vi.fn(async () => {
  calls.push('create');
  return { id: PLACEMENT };
});
const placementCount = vi.fn(async () => 0);
const placementFindMany = vi.fn(async () => [] as unknown[]);
const placementGroupBy = vi.fn(async () => [] as unknown[]);
const transactionFindMany = vi.fn(async () => [] as unknown[]);

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    placement: { create: placementCreate, count: placementCount, findUnique: vi.fn() },
  },
  dbRead: {
    placement: { findMany: placementFindMany, groupBy: placementGroupBy },
    placementTransaction: { findMany: transactionFindMany },
  },
}));

const { createStickerPlacement, getStickerPlacements, getPlacementSettlementStates } = await import(
  '~/server/services/sticker-placement.service'
);

const OPEN_SPACE = { ownerId: OWNER, mode: 'review', setPrice: PRICE, price: PRICE, cap: 5000 };

/**
 * The two raw reads the mutation makes, in the order it makes them: the sticker
 * with its ownership, then the balance.
 */
const givenStickerAndBalance = (
  sticker: { owned: boolean; createdById: number | null } = { owned: true, createdById: SELLER },
  balance: { spendable: number | null; unlimited: boolean } = { spendable: 3, unlimited: false }
) => {
  queryRaw
    .mockResolvedValueOnce([
      { id: COSMETIC, createdById: sticker.createdById, owned: sticker.owned },
    ])
    .mockResolvedValueOnce([balance]);
};

const placeInput = {
  placerId: PLACER,
  imageId: IMAGE,
  data: { cosmeticId: COSMETIC, x: 0.25, y: 0.75, scale: 0.2, rotation: 15 },
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  // Reset, not clear: `mockResolvedValueOnce` queues survive `clearAllMocks`, so
  // a test that refuses before consuming its queued rows would hand them to the
  // next one — which passes, against the wrong fixture.
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
  resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE });
  placementCount.mockResolvedValue(0);
  holdPlacementEscrow.mockImplementation(async () => {
    calls.push('hold');
    return { fee: 210, principal: 490 };
  });
  spendStickerUsesFor.mockImplementation(async () => {
    calls.push('spend');
  });
  settlePlacement.mockImplementation(async ({ action }: { action: string }) => {
    calls.push(`settle:${action}`);
    return { settled: true };
  });
});

describe('every guard refuses the mutation rather than filtering a listing', () => {
  it('refuses a space that is switched off', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, mode: 'off' });

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/not accepting stickers/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses a space with no price, rather than treating unpriced as free', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, setPrice: null, price: null });

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/has not set a price/);
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('refuses placing on your own content', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, ownerId: PLACER });

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/your own content/);
  });

  // The block and suspension guard is a primary read that throws. Its refusal
  // has to stop the placement, not be logged and stepped over.
  it('refuses when the block guard throws', async () => {
    assertCanPlace.mockRejectedValueOnce(new Error('placement: placement is not available'));

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/not available/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses past the pending cap for one owner', async () => {
    placementCount.mockResolvedValue(10);

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/maximum pending/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('refuses a sticker the placer does not own', async () => {
    givenStickerAndBalance({ owned: false, createdById: SELLER });

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/do not own that sticker/);
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('refuses when no uses are left, before charging anything', async () => {
    givenStickerAndBalance(
      { owned: true, createdById: SELLER },
      { spendable: 0, unlimited: false }
    );

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/uses left/);
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  it('allows an unlimited holding, which reports a null balance', async () => {
    givenStickerAndBalance(
      { owned: true, createdById: SELLER },
      { spendable: null, unlimited: true }
    );

    await expect(createStickerPlacement(placeInput)).resolves.toMatchObject({
      placementId: PLACEMENT,
    });
  });
});

describe("the creator's size limit", () => {
  const OVERSIZE = { ...placeInput.data, scale: 0.35 };
  const capped = { ...OPEN_SPACE, settings: { maxScale: 0.2 } };

  it('refuses a sticker larger than the creator allows', async () => {
    resolvePlacementSpaceFor.mockResolvedValue(capped);
    givenStickerAndBalance();

    await expect(createStickerPlacement({ ...placeInput, data: OVERSIZE })).rejects.toThrow(
      /up to 20%/
    );
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('lets a moderator exceed it', async () => {
    resolvePlacementSpaceFor.mockResolvedValue(capped);
    givenStickerAndBalance();

    await expect(
      createStickerPlacement({ ...placeInput, data: OVERSIZE, isModerator: true })
    ).resolves.toMatchObject({ placementId: PLACEMENT });
  });

  it('applies the default when the creator has set nothing', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, settings: {} });
    givenStickerAndBalance();

    // 0.35 is inside the global ceiling and outside the default, so this fails
    // only if the default is being applied rather than the hard maximum.
    await expect(createStickerPlacement({ ...placeInput, data: OVERSIZE })).rejects.toThrow(
      /up to 25%/
    );
  });

  /**
   * The limit binds at placement and never afterwards.
   *
   * This is a test aimed at a change nobody has made yet, which is the point.
   * Someone will see a placement rendering above the creator's current limit,
   * read it as stale data, and clamp on read — **that change would look like a
   * bug fix and would be one.** A creator lowering their limit does not get to
   * shrink placements people already paid for, and nothing else fails when it
   * happens: the sticker just quietly gets smaller.
   */
  it('never consults the space when reading placements back', async () => {
    placementFindMany.mockResolvedValueOnce([]);

    await getStickerPlacements({ imageIds: [IMAGE] });

    // The clamp-on-read someone would write needs the creator's current limit in
    // hand. Asserting the read never asks for it is the guard that fails when
    // they reach for it, which the scale assertion below cannot do on its own.
    expect(resolvePlacementSpaceFor).not.toHaveBeenCalled();
  });

  it('leaves an existing placement at the size it was accepted at', async () => {
    placementFindMany.mockResolvedValueOnce([
      {
        id: 7,
        targetId: IMAGE,
        placerId: PLACER,
        ownerId: OWNER,
        status: 'approved',
        amount: PRICE,
        data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.35, rotation: 0 },
      },
    ]);
    // The creator has since tightened the limit well below that placement.
    resolvePlacementSpaceFor.mockResolvedValue(capped);

    const [placed] = await getStickerPlacements({ imageIds: [IMAGE] });

    expect(placed.data.scale).toBe(0.35);
  });
});

describe('the order money and uses move in', () => {
  it('creates the row, then holds, then spends the use', async () => {
    givenStickerAndBalance();

    await createStickerPlacement(placeInput);

    // The row must exist before the hold — its id is a parameter, and the hold's
    // ledger rows carry a foreign key to it. The use is spent last so a failed
    // charge cannot consume one.
    expect(calls).toEqual(['create', 'hold', 'spend']);
  });

  it('expires the placement when the escrow cannot be taken, and rethrows', async () => {
    givenStickerAndBalance();
    holdPlacementEscrow.mockRejectedValueOnce(new Error('buzz service down'));

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/buzz service down/);

    // Expiry refunds both holds in full through real refunds of real holds, so a
    // partial hold reverses in the currency mix it was drawn from.
    expect(calls).toEqual(['create', 'settle:expire']);
    expect(spendStickerUsesFor).not.toHaveBeenCalled();
  });

  it('expires the placement when the use cannot be spent, so nothing is charged for nothing', async () => {
    givenStickerAndBalance();
    spendStickerUsesFor.mockRejectedValueOnce(new Error('out of uses'));

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/out of uses/);
    expect(calls).toEqual(['create', 'hold', 'settle:expire']);
  });

  // The compensating settle failing must not swallow the original error: the
  // caller has to learn the placement failed, and the row still carries an
  // expiresAt so the expiry job reaches it.
  it('still reports the original failure when the unwind also fails', async () => {
    givenStickerAndBalance();
    holdPlacementEscrow.mockRejectedValueOnce(new Error('buzz service down'));
    settlePlacement.mockRejectedValueOnce(new Error('buzz still down'));

    await expect(createStickerPlacement(placeInput)).rejects.toThrow(/buzz service down/);
  });
});

describe('the space mode decides whether a placement is live', () => {
  it('settles an auto space immediately', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, mode: 'auto' });
    givenStickerAndBalance();

    const result = await createStickerPlacement(placeInput);

    expect(result.status).toBe('approved');
    expect(calls).toEqual(['create', 'hold', 'spend', 'settle:approve']);
  });

  it('leaves a review space pending, with nothing settled', async () => {
    givenStickerAndBalance();

    const result = await createStickerPlacement(placeInput);

    expect(result.status).toBe('pending');
    expect(settlePlacement).not.toHaveBeenCalled();
  });
});

describe('what gets written to the row', () => {
  it('persists the seller and the normalized position', async () => {
    givenStickerAndBalance();

    await createStickerPlacement({
      ...placeInput,
      // Past the edges: a drag that left the image is a normal gesture, so the
      // position clamps rather than rejecting. Size is a different matter — it
      // is refused above the creator's limit, so it stays inside one here.
      data: { cosmeticId: COSMETIC, x: 1.4, y: -0.3, scale: 0.2, rotation: 15 },
    });

    expect(placementCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // On the row, not a settle-time argument: settlement is resumable, and
          // a sweeper that never saw it would strand the seller's share.
          sellerId: SELLER,
          amount: PRICE,
          status: 'pending',
          data: { cosmeticId: COSMETIC, x: 1, y: 0, scale: 0.2, rotation: 15 },
        }),
      })
    );
  });

  it('stores a null seller when the cosmetic has no creator', async () => {
    givenStickerAndBalance({ owned: true, createdById: null });

    await createStickerPlacement(placeInput);

    expect(placementCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sellerId: null }) })
    );
  });
});

describe('a pending placement is visible to the person who paid for it and nobody else', () => {
  it('scopes pending to the placer and the owner, and to nobody else', async () => {
    await getStickerPlacements({ imageIds: [IMAGE], viewerId: PLACER });

    const { where } = placementFindMany.mock.calls[0][0] as {
      where: { OR: { status: string; placerId?: number; ownerId?: number }[] };
    };
    const pending = where.OR.filter((clause) => clause.status === 'pending');

    // Asserted as whole clauses, not as a list of ids. The viewer is the same
    // person in both roles, so `placerId ?? ownerId` collapsed them to the same
    // value — and the test then passed with either clause duplicated, which is
    // exactly the mutation it exists to catch. The key name is the discriminator.
    expect(pending).toEqual([
      { status: 'pending', placerId: PLACER },
      { status: 'pending', ownerId: PLACER },
    ]);
  });

  it('asks for approved placements only when nobody is signed in', async () => {
    await getStickerPlacements({ imageIds: [IMAGE] });

    const { where } = placementFindMany.mock.calls[0][0] as {
      where: { OR: { status: string }[] };
    };
    expect(where.OR.map((clause) => clause.status)).toEqual(['approved']);
  });

  it('drops a row whose payload is not a placement rather than rendering a hole', async () => {
    placementFindMany.mockResolvedValueOnce([
      {
        id: 1,
        targetId: IMAGE,
        placerId: PLACER,
        ownerId: OWNER,
        status: 'approved',
        amount: PRICE,
        data: { legacy: true },
      },
    ]);

    await expect(getStickerPlacements({ imageIds: [IMAGE] })).resolves.toEqual([]);
  });
});

describe('settlement state comes from the ledger, never from Placement.status', () => {
  it('reports settled when every leg carries a receipt', async () => {
    placementFindMany.mockResolvedValueOnce([{ id: PLACEMENT }]);
    transactionFindMany.mockResolvedValueOnce([
      { placementId: PLACEMENT, transactionId: 'buzz-1', attempts: 1 },
    ]);

    await expect(getPlacementSettlementStates([PLACEMENT], PLACER)).resolves.toEqual({
      [PLACEMENT]: 'settled',
    });
  });

  it('reports pending while an unpaid leg is still being retried', async () => {
    placementFindMany.mockResolvedValueOnce([{ id: PLACEMENT }]);
    transactionFindMany.mockResolvedValueOnce([
      { placementId: PLACEMENT, transactionId: null, attempts: 2 },
    ]);

    await expect(getPlacementSettlementStates([PLACEMENT], PLACER)).resolves.toEqual({
      [PLACEMENT]: 'pending',
    });
  });

  // The case the whole rule exists for: the placement reads a clean `approved`
  // while somebody is still owed and nothing will pay them without a human.
  it('reports stalled when a leg has exhausted its retries', async () => {
    placementFindMany.mockResolvedValueOnce([{ id: PLACEMENT }]);
    transactionFindMany.mockResolvedValueOnce([
      { placementId: PLACEMENT, transactionId: null, attempts: 5 },
    ]);

    await expect(getPlacementSettlementStates([PLACEMENT], PLACER)).resolves.toEqual({
      [PLACEMENT]: 'stalled',
    });
  });

  it('keeps stalled once a sibling leg has given up', async () => {
    placementFindMany.mockResolvedValueOnce([{ id: PLACEMENT }]);
    transactionFindMany.mockResolvedValueOnce([
      { placementId: PLACEMENT, transactionId: null, attempts: 5 },
      { placementId: PLACEMENT, transactionId: null, attempts: 1 },
    ]);

    await expect(getPlacementSettlementStates([PLACEMENT], PLACER)).resolves.toEqual({
      [PLACEMENT]: 'stalled',
    });
  });

  it('tells a stranger nothing about a placement they are not party to', async () => {
    // The visibility read returns nothing for an unrelated viewer, so there is
    // no state to report. Without this scope any signed-in user could enumerate
    // whether an arbitrary placement had paid out.
    placementFindMany.mockResolvedValueOnce([]);

    await expect(getPlacementSettlementStates([PLACEMENT], 999_999)).resolves.toEqual({});
    expect(transactionFindMany).not.toHaveBeenCalled();
  });

  it('never reads the hold legs, which are not payouts', async () => {
    placementFindMany.mockResolvedValueOnce([{ id: PLACEMENT }]);
    await getPlacementSettlementStates([PLACEMENT], PLACER);

    const { where } = transactionFindMany.mock.calls[0][0] as {
      where: { kind: { notIn: string[] } };
    };
    expect(where.kind.notIn).toEqual(['holdFee', 'holdPrincipal']);
  });
});
