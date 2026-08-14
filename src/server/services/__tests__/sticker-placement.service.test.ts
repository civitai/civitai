import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type * as MetricHelpers from '~/server/utils/metric-helpers';
import { STICKER_REMOVAL_LOCK_HOURS } from '~/shared/utils/sticker-placement';

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

/**
 * `setPrice` is what the owner asks; `price` is `min(setPrice, cap)` — what a
 * placer is actually charged. They diverge exactly when the cap bites, which is
 * the only case the cap exists for, so a fixture where they are equal lets every
 * charge site read the wrong one and still pass. Kept apart deliberately.
 */
const STRANGER = 159;
const ASKED = 900;
const CAP = 700;
const PRICE = 700;

const holdPlacementEscrow = vi.fn();
const settlePlacement = vi.fn<PrismaStub<{ settled: boolean }>>(async () => ({ settled: true }));
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

/**
 * Every Prisma stub declares its argument, rather than letting `vi.fn(async () => …)`
 * infer a zero-arg signature. That inference makes `mock.calls` the empty tuple `[]`,
 * so the `calls[0][0]` reads below — which are how this file asserts the WHERE clauses
 * the guards are made of — are type errors against their own mock. `unknown` is the
 * honest parameter type: the per-site casts stay, and they are what pins each shape.
 */
type PrismaStub<T> = (args: unknown) => Promise<T>;

const queryRaw = vi.fn();
const placementCreate = vi.fn<PrismaStub<{ id: number }>>(async () => {
  calls.push('create');
  return { id: PLACEMENT };
});
const placementCount = vi.fn<PrismaStub<number>>(async () => 0);
const placementFindMany = vi.fn<PrismaStub<unknown[]>>(async () => []);
const placementGroupBy = vi.fn<PrismaStub<unknown[]>>(async () => []);
const transactionFindMany = vi.fn<PrismaStub<unknown[]>>(async () => []);
const placementFindFirst = vi.fn<PrismaStub<unknown>>(async () => null);
const cosmeticFindUnique = vi.fn<PrismaStub<unknown>>(async () => null);

const imageFindMany = vi.fn<PrismaStub<unknown[]>>(async () => []);
const placementFindUnique = vi.fn<PrismaStub<unknown>>(async () => null);
const placementUpdate = vi.fn<PrismaStub<object>>(async () => ({}));
const placementUpdateMany = vi.fn<PrismaStub<{ count: number }>>(async () => ({ count: 1 }));

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    placement: {
      create: placementCreate,
      count: placementCount,
      findUnique: placementFindUnique,
      update: placementUpdate,
      updateMany: placementUpdateMany,
    },
  },
  dbRead: {
    placement: {
      findMany: placementFindMany,
      groupBy: placementGroupBy,
      findFirst: placementFindFirst,
    },
    image: { findMany: imageFindMany },
    placementTransaction: { findMany: transactionFindMany },
    cosmetic: { findUnique: cosmeticFindUnique },
  },
}));

const updateEntityMetricDetached = vi.fn(async () => undefined);
vi.mock('~/server/utils/metric-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricHelpers>()),
  updateEntityMetricDetached,
}));

const {
  actOnStickerPlacement,
  setStickerCommentHidden,
  createStickerPlacement,
  getStickerPlacements,
  getPlacementSettlementStates,
  getStickerPlacementDetail,
  getPendingStickerPlacements,
} = await import('~/server/services/sticker-placement.service');

const OPEN_SPACE = { ownerId: OWNER, mode: 'review', setPrice: ASKED, price: PRICE, cap: CAP };

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
  placementUpdateMany.mockResolvedValue({ count: 1 });
  placementUpdate.mockImplementation(async () => {
    calls.push('hideComment');
    return {};
  });
  holdPlacementEscrow.mockImplementation(async () => {
    calls.push('hold');
    return { fee: 210, principal: 490 };
  });
  spendStickerUsesFor.mockImplementation(async () => {
    calls.push('spend');
  });
  settlePlacement.mockImplementation(async (args) => {
    const { action } = args as { action: string };
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

    await expect(
      createStickerPlacement({ spendType: 'yellow', ...placeInput, data: OVERSIZE })
    ).rejects.toThrow(/up to 20%/);
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it('lets a moderator exceed it', async () => {
    resolvePlacementSpaceFor.mockResolvedValue(capped);
    givenStickerAndBalance();

    await expect(
      createStickerPlacement({
        spendType: 'yellow',
        ...placeInput,
        data: OVERSIZE,
        isModerator: true,
      })
    ).resolves.toMatchObject({ placementId: PLACEMENT });
  });

  it('applies the default when the creator has set nothing', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, settings: {} });
    givenStickerAndBalance();

    // 0.35 is inside the global ceiling and outside the default, so this fails
    // only if the default is being applied rather than the hard maximum.
    await expect(
      createStickerPlacement({ spendType: 'yellow', ...placeInput, data: OVERSIZE })
    ).rejects.toThrow(/up to 25%/);
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

  /**
   * Layer order is placement order, and the client cannot order what it was not
   * told. Dropping `createdAt` from the select is a plausible tidy-up — nothing
   * in the payload is named after it — and it degrades into stickers stacking in
   * whatever order Prisma happened to return, which only shows up where two of
   * them overlap.
   */
  it('carries when each placement was made', async () => {
    const placedAt = new Date('2026-08-12T12:00:00Z');
    placementFindMany.mockResolvedValueOnce([
      {
        id: 7,
        targetId: IMAGE,
        placerId: PLACER,
        ownerId: OWNER,
        status: 'approved',
        amount: PRICE,
        data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.35, rotation: 0 },
        createdAt: placedAt,
      },
    ]);

    const [placed] = await getStickerPlacements({ imageIds: [IMAGE] });

    expect(placed.placedAt).toEqual(placedAt);
    expect(placementFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } })
    );
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

  it('holds escrow for the capped price, not the price the owner asked for', async () => {
    givenStickerAndBalance();

    await createStickerPlacement(placeInput);

    // The only assertion on what the escrow is actually told to charge. The row
    // is asserted separately; both read `space.price`, and nothing else in the
    // service reads `setPrice` or `cap` at all.
    expect(holdPlacementEscrow).toHaveBeenCalledWith(expect.objectContaining({ amount: PRICE }));
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
  // The currency is decided by the domain at the router and carried through
  // untouched. A placement that reached the escrow without it would be held —
  // and later paid out — in whatever the Buzz service defaults to.
  it('carries the caller currency into the escrow', async () => {
    givenStickerAndBalance();

    await createStickerPlacement({ ...placeInput, spendType: 'green' });

    expect(holdPlacementEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ spendType: 'green' })
    );
  });

  it('persists the seller and the normalized position', async () => {
    givenStickerAndBalance();

    await createStickerPlacement({
      spendType: 'yellow',
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
          // `flip` and `opacity` are written even though this call omits them:
          // the row is what every later reader draws from, and a key that is
          // absent there is one each of those readers has to remember to
          // default. Full strength and unmirrored is what an omission means.
          data: {
            cosmeticId: COSMETIC,
            x: 1,
            y: 0,
            scale: 0.2,
            rotation: 15,
            flip: false,
            opacity: 1,
          },
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

describe('the hover-card detail', () => {
  const DETAIL_PLACEMENT = 137;
  const CREATOR = 148;

  const givenPlacement = () =>
    placementFindFirst.mockResolvedValue({
      id: DETAIL_PLACEMENT,
      createdAt: new Date(0),
      status: 'approved',
      data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
      placer: { id: PLACER, username: 'placer' },
    });

  beforeEach(() => {
    placementFindFirst.mockReset();
    cosmeticFindUnique.mockReset();
  });

  it('carries the sticker and its creator', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue({
      id: COSMETIC,
      name: 'Gumdong',
      creator: { id: CREATOR, username: 'maker' },
    });

    const detail = await getStickerPlacementDetail({
      placementId: DETAIL_PLACEMENT,
      viewerId: PLACER,
    });

    expect(detail.sticker).toMatchObject({ id: COSMETIC, name: 'Gumdong' });
    expect(detail.sticker?.creatorName).toBe('maker');
    // The href, built once here rather than by every consumer.
    expect(detail.sticker?.shopHref).toBe('/user/maker/shop');
  });

  /**
   * `deleteUser` soft-deletes: it nulls `username` and leaves the row, so the
   * relation is still present with nothing to link to. A consumer testing the
   * relation rather than the username built `/user/null/shop`.
   */
  it('reports a deleted creator as a null username rather than omitting them', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue({
      id: COSMETIC,
      name: 'Gumdong',
      creator: { id: CREATOR, username: null },
    });

    const detail = await getStickerPlacementDetail({
      placementId: DETAIL_PLACEMENT,
      viewerId: PLACER,
    });

    // Both, not just one: a null name with a live href would still produce the
    // broken link, and an href with no name would render an empty anchor.
    expect(detail.sticker?.creatorName).toBeNull();
    expect(detail.sticker?.shopHref).toBeNull();
  });

  it('scopes pending to the placer and the owner', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue(null);

    await getStickerPlacementDetail({ placementId: DETAIL_PLACEMENT, viewerId: PLACER });

    const [query] = placementFindFirst.mock.calls[0] as [{ where: { OR: MixedObject[] } }];
    const pending = query.where.OR.filter((clause) => clause.status === 'pending');
    expect(pending).toEqual([
      { status: 'pending', placerId: PLACER },
      { status: 'pending', ownerId: PLACER },
    ]);
  });

  // The title above used to say this test refused a stranger. It never drove one
  // — a title claiming a refusal is covered is how an uncovered refusal stays
  // uncovered, so the refusal now has its own case.
  it('refuses a stranger, rather than returning what the scope excluded', async () => {
    placementFindFirst.mockResolvedValueOnce(null);

    await expect(
      getStickerPlacementDetail({ placementId: DETAIL_PLACEMENT, viewerId: STRANGER })
    ).rejects.toThrow(/not available/);
  });

  // A moderator is party to neither side of a pending placement, so the scoping
  // hides the one row they are most often asked to act on.
  it('lets a moderator see a pending placement they are not party to', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue(null);

    await getStickerPlacementDetail({
      placementId: DETAIL_PLACEMENT,
      viewerId: STRANGER,
      isModerator: true,
    });

    const [query] = placementFindFirst.mock.calls[0] as [{ where: { OR: MixedObject[] } }];
    expect(query.where.OR.map((clause) => clause.status).sort()).toEqual(['approved', 'pending']);
  });

  // Widened to the other LIVE status, not to every status. Every consumer reads
  // a miss as "already gone", so returning a removed row hands the second
  // moderator on a report a remove button, a dialog claiming no Buzz moves, and
  // an error when they press it.
  it('does not hand a moderator placements that are already settled', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue(null);

    await getStickerPlacementDetail({
      placementId: DETAIL_PLACEMENT,
      viewerId: STRANGER,
      isModerator: true,
    });

    const [query] = placementFindFirst.mock.calls[0] as [{ where: { OR?: MixedObject[] } }];
    expect(query.where.OR).toBeDefined();
    const statuses = query.where.OR?.map((clause) => clause.status) ?? [];
    for (const settled of ['removed', 'declined', 'expired'])
      expect(statuses).not.toContain(settled);
  });

  it('asks for approved only when nobody is signed in', async () => {
    givenPlacement();
    cosmeticFindUnique.mockResolvedValue(null);

    await getStickerPlacementDetail({ placementId: DETAIL_PLACEMENT });

    const [query] = placementFindFirst.mock.calls[0] as [{ where: { OR: MixedObject[] } }];
    expect(query.where.OR.map((clause) => clause.status)).toEqual(['approved']);
  });
});

/**
 * The image's Buzz counter, which the 2026-08-12 review agreed a sticker should
 * move: a placement reads as a pseudo-tip, so it counts toward the number people
 * already look at.
 */
describe("a placement counts toward the image's Buzz counter", () => {
  const givenApprovable = () =>
    placementFindUnique.mockResolvedValue({
      id: PLACEMENT,
      ownerId: OWNER,
      placerId: PLACER,
      targetId: IMAGE,
      amount: PRICE,
      status: 'pending',
      surface: 'sticker',
      data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
      createdAt: new Date(0),
      resolvedAt: null,
    });

  /**
   * The settlement paths emit NOTHING. The counter is moved by
   * `placement-sweep-uncounted` reading `metricCountedAt`, and these paths
   * exist here so that stays true: an emit put back on any of them is one the
   * sweep will emit again, and the counter never comes back down.
   */
  it('emits nothing when an auto space approves on placement', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ...OPEN_SPACE, mode: 'auto' });
    givenStickerAndBalance();

    await createStickerPlacement(placeInput);

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });

  it('emits nothing when the owner approves from the queue', async () => {
    givenApprovable();

    await actOnStickerPlacement({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });

  it('emits nothing when the owner declines', async () => {
    givenApprovable();

    await actOnStickerPlacement({ placementId: PLACEMENT, action: 'decline', userId: OWNER });

    expect(updateEntityMetricDetached).not.toHaveBeenCalled();
  });
});

/**
 * The week an approved sticker stays up.
 *
 * Approval pays the owner and removal refunds nothing, so without the lock an
 * owner could accept a sticker, bank the Buzz and wipe it before anyone saw it.
 */
describe('the owner cannot remove a sticker for a week after approving it', () => {
  const HOUR_MS = 60 * 60 * 1000;

  const givenApproved = (approvedHoursAgo: number, resolved = true) => {
    const at = new Date(Date.now() - approvedHoursAgo * HOUR_MS);
    placementFindUnique.mockResolvedValue({
      id: PLACEMENT,
      ownerId: OWNER,
      placerId: PLACER,
      targetId: IMAGE,
      amount: PRICE,
      status: 'approved',
      surface: 'sticker',
      data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
      createdAt: at,
      resolvedAt: resolved ? at : null,
    });
  };

  it('refuses inside the week, and says when it opens', async () => {
    givenApproved(STICKER_REMOVAL_LOCK_HOURS - 1);

    await expect(
      actOnStickerPlacement({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/stays up for a week/);
    expect(placementUpdateMany).not.toHaveBeenCalled();
  });

  it('allows it once the week is up, and moves no money', async () => {
    givenApproved(STICKER_REMOVAL_LOCK_HOURS + 1);

    await actOnStickerPlacement({ placementId: PLACEMENT, action: 'remove', userId: OWNER });

    const [write] = placementUpdateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(write.data).toMatchObject({ status: 'removed', removedBy: 'owner' });
    // `settlePlacement` claims `WHERE status = 'pending'`, so routing a live row
    // through it would report success and change nothing.
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  /**
   * Fails CLOSED on a row with no `resolvedAt`. Skipping the check when the
   * column is absent would let a hand-seeded row — or anything predating the
   * approval path writing it — be removed immediately, which is the exact case
   * the lock exists for.
   */
  it('measures from createdAt when the approval time is missing', async () => {
    givenApproved(0, false);

    await expect(
      actOnStickerPlacement({ placementId: PLACEMENT, action: 'remove', userId: OWNER })
    ).rejects.toThrow(/stays up for a week/);
  });

  /**
   * A takedown is a moderation record, not an owner decision, and the abusive
   * cases are the ones that must not wait. The exemption follows the role being
   * exercised — an owner who is also a moderator is still the owner here.
   */
  it('does not bind a moderator acting on content that is not theirs', async () => {
    givenApproved(1);

    await actOnStickerPlacement({
      placementId: PLACEMENT,
      action: 'remove',
      userId: STRANGER,
      isModerator: true,
    });

    const [write] = placementUpdateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(write.data).toMatchObject({ removedBy: 'moderator' });
  });

  it('still binds an owner who happens to be a moderator', async () => {
    givenApproved(1);

    await expect(
      actOnStickerPlacement({
        placementId: PLACEMENT,
        action: 'remove',
        userId: OWNER,
        isModerator: true,
      })
    ).rejects.toThrow(/stays up for a week/);
  });
});

/** The optional note, and the partial approval that refuses it. */
describe('the note on a placement', () => {
  const withComment = (comment?: string) =>
    placementFindUnique.mockResolvedValue({
      id: PLACEMENT,
      ownerId: OWNER,
      placerId: PLACER,
      targetId: IMAGE,
      amount: PRICE,
      status: 'pending',
      surface: 'sticker',
      data: {
        cosmeticId: COSMETIC,
        x: 0.5,
        y: 0.5,
        scale: 0.2,
        rotation: 0,
        ...(comment ? { comment } : {}),
      },
      createdAt: new Date(0),
      resolvedAt: null,
    });

  it('is stored with the placement, trimmed and collapsed', async () => {
    givenStickerAndBalance();

    await createStickerPlacement({
      spendType: 'yellow',
      ...placeInput,
      data: { ...placeInput.data, comment: '  love   this\n\none  ' },
    });

    const [write] = placementCreate.mock.calls[0] as [{ data: { data: { comment?: string } } }];
    expect(write.data.data.comment).toBe('love this one');
  });

  it('stores no comment key at all when the field was left blank', async () => {
    givenStickerAndBalance();

    await createStickerPlacement({
      spendType: 'yellow',
      ...placeInput,
      data: { ...placeInput.data, comment: '   ' },
    });

    const [write] = placementCreate.mock.calls[0] as [{ data: { data: Record<string, unknown> } }];
    expect(write.data.data).not.toHaveProperty('comment');
  });

  it('is hidden by an approve that refuses it, before the placement goes live', async () => {
    withComment('nice hat');

    await actOnStickerPlacement({
      placementId: PLACEMENT,
      action: 'approve',
      userId: OWNER,
      hideComment: true,
    });

    const [write] = placementUpdate.mock.calls[0] as [{ data: { data: Record<string, unknown> } }];
    expect(write.data.data).toMatchObject({ comment: 'nice hat', commentHidden: true });
    // The rest of the payload survives: refusing a note must not be a way to
    // move the sticker it was attached to.
    expect(write.data.data).toMatchObject({ cosmeticId: COSMETIC, x: 0.5, scale: 0.2 });
    // "Before it goes live" is the property the name claims, and it is the one
    // an assertion about the payload alone cannot see. Move the hide after the
    // settle and only this line fails.
    expect(calls).toEqual(['hideComment', 'settle:approve']);
  });

  /**
   * The owner can refuse a note from the hover card while the placement is
   * still pending. A plain Approve must leave that decision alone — treating
   * "no opinion" as "show it" publishes text the owner explicitly refused, and
   * publishing is the direction that cannot be taken back.
   */
  it('is left alone by a plain approve, rather than being un-hidden', async () => {
    placementFindUnique.mockResolvedValue({
      id: PLACEMENT,
      ownerId: OWNER,
      placerId: PLACER,
      targetId: IMAGE,
      amount: PRICE,
      status: 'pending',
      surface: 'sticker',
      data: {
        cosmeticId: COSMETIC,
        x: 0.5,
        y: 0.5,
        scale: 0.2,
        rotation: 0,
        comment: 'nice hat',
        commentHidden: true,
      },
      createdAt: new Date(0),
      resolvedAt: null,
    });

    await actOnStickerPlacement({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    expect(placementUpdate).not.toHaveBeenCalled();
  });

  /**
   * The only thing stopping a stranger flipping the flag on someone else's
   * placement. Delete the ownership check and this is what fails.
   */
  it('cannot be hidden by someone who does not own the content', async () => {
    withComment('nice hat');

    await expect(
      setStickerCommentHidden({ placementId: PLACEMENT, hidden: true, userId: STRANGER })
    ).rejects.toThrow(/not on your content/);
    expect(placementUpdate).not.toHaveBeenCalled();
  });

  it('can be hidden by a moderator', async () => {
    withComment('nice hat');

    await setStickerCommentHidden({
      placementId: PLACEMENT,
      hidden: true,
      userId: STRANGER,
      isModerator: true,
    });

    expect(placementUpdate).toHaveBeenCalled();
  });

  /**
   * Hiding is the owner's judgement about their own image, not a deletion. The
   * three parties with a reason to see it keep seeing it — the owner who hid it,
   * the placer who wrote and paid for it, and a moderator acting on a report,
   * which is about text nobody else can read.
   */
  describe('once hidden', () => {
    const givenHidden = () =>
      placementFindFirst.mockResolvedValue({
        id: PLACEMENT,
        createdAt: new Date(0),
        resolvedAt: new Date(0),
        status: 'approved',
        ownerId: OWNER,
        placerId: PLACER,
        data: {
          cosmeticId: COSMETIC,
          x: 0.5,
          y: 0.5,
          scale: 0.2,
          rotation: 0,
          comment: 'nice hat',
          commentHidden: true,
        },
        placer: { id: PLACER, username: 'placer' },
      });

    beforeEach(() => {
      placementFindFirst.mockReset();
      cosmeticFindUnique.mockReset();
      cosmeticFindUnique.mockResolvedValue(null);
    });

    it('is withheld from everyone else', async () => {
      givenHidden();

      const detail = await getStickerPlacementDetail({
        placementId: PLACEMENT,
        viewerId: STRANGER,
      });

      expect(detail.comment).toBeNull();
      // Not merely textless. Saying a note was refused tells a stranger one
      // existed and how the owner judged it — the fact withholding the text was
      // protecting.
      expect(detail.commentHidden).toBe(false);
    });

    it('tells the placer their note is not live, so they are not left guessing', async () => {
      givenHidden();

      const detail = await getStickerPlacementDetail({ placementId: PLACEMENT, viewerId: PLACER });

      expect(detail.commentHidden).toBe(true);
    });

    it('tells the owner, whose control it labels', async () => {
      givenHidden();

      const detail = await getStickerPlacementDetail({ placementId: PLACEMENT, viewerId: OWNER });

      expect(detail.commentHidden).toBe(true);
    });

    it('stays readable to the placer who paid for it', async () => {
      givenHidden();

      const detail = await getStickerPlacementDetail({ placementId: PLACEMENT, viewerId: PLACER });

      expect(detail.comment).toBe('nice hat');
    });

    it('stays readable to a moderator acting on a report about it', async () => {
      givenHidden();

      const detail = await getStickerPlacementDetail({
        placementId: PLACEMENT,
        viewerId: STRANGER,
        isModerator: true,
      });

      expect(detail.comment).toBe('nice hat');
    });
  });

  /**
   * `getStickerPlacements` is a public procedure that runs for every image on a
   * feed page. Stripping the text out of it is the entire control keeping notes
   * — hidden ones above all — from being serialised to anonymous viewers, and
   * the whole rest of this file stays green if that strip is removed.
   */
  describe('is never carried by the feed listing', () => {
    const givenListed = (data: Record<string, unknown>) =>
      placementFindMany.mockResolvedValueOnce([
        {
          id: PLACEMENT,
          targetId: IMAGE,
          placerId: PLACER,
          ownerId: OWNER,
          status: 'approved',
          amount: PRICE,
          data: { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0, ...data },
        },
      ]);

    it('withholds the text even from the placer, who is allowed to read it', async () => {
      givenListed({ comment: 'nice hat' });

      const [placed] = await getStickerPlacements({ imageIds: [IMAGE], viewerId: PLACER });

      expect(placed.data.comment).toBeUndefined();
      // The flag has to travel, because the sticker needs a marker before
      // anyone hovers it — but the flag is not the text.
      expect(placed.hasComment).toBe(true);
    });

    it('does not even admit a hidden note exists, to a stranger', async () => {
      givenListed({ comment: 'nice hat', commentHidden: true });

      const [placed] = await getStickerPlacements({ imageIds: [IMAGE], viewerId: STRANGER });

      expect(placed.data.comment).toBeUndefined();
      expect(placed.data.commentHidden).toBeUndefined();
      expect(placed.hasComment).toBe(false);
    });

    it('still marks a hidden note for the owner, who can act on it', async () => {
      givenListed({ comment: 'nice hat', commentHidden: true });

      const [placed] = await getStickerPlacements({ imageIds: [IMAGE], viewerId: OWNER });

      expect(placed.hasComment).toBe(true);
    });

    /**
     * `isStickerPlacementData` validates the geometry and stops there, which is
     * right — a malformed note should not stop the sticker drawing. So the read
     * is where the note has to prove it is a string.
     */
    it('treats a non-string note on the row as no note at all', async () => {
      givenListed({ comment: 42 });

      const [placed] = await getStickerPlacements({ imageIds: [IMAGE], viewerId: PLACER });

      expect(placed.hasComment).toBe(false);
    });
  });

  it('writes no flag onto a placement that never carried one', async () => {
    withComment();

    await actOnStickerPlacement({
      placementId: PLACEMENT,
      action: 'approve',
      userId: OWNER,
      hideComment: true,
    });

    expect(placementUpdate).not.toHaveBeenCalled();
  });
});

/**
 * The sticker copy of the queue paging. Its own tests rather than trusting the
 * remix twin: the two are hand-duplicated, and the failure mode is a placement
 * nobody ever reviews while its escrow expires.
 */
describe('getPendingStickerPlacements paging', () => {
  const LEVELS = { domainLevels: allBrowsingLevelsFlag, viewerLevels: allBrowsingLevelsFlag };
  const good = { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 };

  const queueRow = (id: number, data: unknown, createdAt: string) => ({
    id,
    targetId: IMAGE,
    placerId: PLACER,
    amount: PRICE,
    data,
    createdAt: new Date(createdAt),
    expiresAt: null,
    placer: { id: PLACER, username: 'someone', image: null },
  });

  it('takes the cursor from the last row of the page, not the last row it returns', async () => {
    // Row 2 is dropped below for an unreadable payload; row 3 is the probe.
    placementFindMany.mockResolvedValue([
      queueRow(1, good, '2026-01-01T00:00:00.000Z'),
      queueRow(2, { nonsense: true }, '2026-01-02T00:00:00.000Z'),
      queueRow(3, good, '2026-01-03T00:00:00.000Z'),
    ]);

    const result = await getPendingStickerPlacements({ ownerId: OWNER, limit: 2, ...LEVELS });

    expect(result.items.map((item) => item.id)).toEqual([1]);
    // Row 2's key. Built from what was returned it would say row 1, and row 2
    // would be served again on the next page.
    expect(result.nextCursor).toBe(`${new Date('2026-01-02T00:00:00.000Z').getTime()}:2`);
  });

  it('still hands back a cursor when EVERY row on the page was filtered out', async () => {
    // Same contract the remix twin pins, and the one the empty-state guard in
    // the page reads: no items is not the same as no more.
    placementFindMany.mockResolvedValue([
      queueRow(1, { nonsense: true }, '2026-01-01T00:00:00.000Z'),
      queueRow(2, { nonsense: true }, '2026-01-02T00:00:00.000Z'),
      queueRow(3, good, '2026-01-03T00:00:00.000Z'),
    ]);

    const result = await getPendingStickerPlacements({ ownerId: OWNER, limit: 2, ...LEVELS });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe(`${new Date('2026-01-02T00:00:00.000Z').getTime()}:2`);
  });

  it('reports no next page when the queue ends exactly on the page boundary', async () => {
    placementFindMany.mockResolvedValue([
      queueRow(1, good, '2026-01-01T00:00:00.000Z'),
      queueRow(2, good, '2026-01-02T00:00:00.000Z'),
    ]);

    const result = await getPendingStickerPlacements({ ownerId: OWNER, limit: 2, ...LEVELS });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('resumes strictly after the cursor row, including its same-millisecond twin', async () => {
    placementFindMany.mockResolvedValue([]);
    const createdAt = new Date('2026-01-02T00:00:00.000Z');

    await getPendingStickerPlacements({
      ...LEVELS,
      ownerId: OWNER,
      limit: 2,
      cursor: `${createdAt.getTime()}:2`,
    });

    const { where, orderBy, take } = placementFindMany.mock.calls.at(-1)?.[0] as {
      where: { OR?: unknown[] };
      orderBy: unknown;
      take: number;
    };
    expect(where.OR).toEqual([{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: 2 } }]);
    expect(orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(take).toBe(3);
  });
});

/**
 * The queue carries no browsing level by design — an owner has to see what is
 * waiting on them — so the payload is the only thing standing between an
 * above-ceiling asset and a SFW client. Unlike the remix gallery the image here
 * is the owner's OWN upload, which changes who is being protected from what but
 * not whether the domain may be sent it.
 */
describe('getPendingStickerPlacements domain ceiling', () => {
  const good = { cosmeticId: COSMETIC, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 };

  const ask = ({
    nsfwLevel,
    domainLevels,
    viewerLevels = allBrowsingLevelsFlag,
  }: {
    nsfwLevel: number;
    domainLevels: number;
    viewerLevels?: number;
  }) => {
    placementFindMany.mockResolvedValue([
      {
        id: 1,
        targetId: IMAGE,
        placerId: PLACER,
        amount: PRICE,
        data: good,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
        placer: { id: PLACER, username: 'someone', image: null },
      },
    ]);
    imageFindMany.mockResolvedValue([
      {
        id: IMAGE,
        url: 'asset',
        name: 'a name',
        width: 1,
        height: 1,
        type: 'image',
        metadata: null,
        nsfwLevel,
      },
    ]);

    return getPendingStickerPlacements({ ownerId: OWNER, limit: 10, domainLevels, viewerLevels });
  };

  it('sends the asset when the image is inside the ceiling', async () => {
    // The positive control: without it every assertion below passes against a
    // queue that withholds everything, which is what `domainLevels: undefined`
    // silently produced before this parameter was required.
    const { items } = await ask({
      nsfwLevel: NsfwLevel.PG,
      domainLevels: sfwBrowsingLevelsFlag,
    });

    expect(items[0].image).toMatchObject({ viewable: true, url: 'asset', name: 'a name' });
  });

  it('withholds the asset above the ceiling while keeping the row actionable', async () => {
    const { items } = await ask({ nsfwLevel: NsfwLevel.X, domainLevels: sfwBrowsingLevelsFlag });

    expect(items).toHaveLength(1);
    expect(items[0].image).toEqual({ viewable: false, id: IMAGE, nsfwLevel: NsfwLevel.X });
    // The fields, not just the flag: a branch that sets `viewable: false` and
    // spreads the row anyway passes a flag check while shipping the bytes.
    for (const field of ['url', 'name', 'metadata', 'width', 'height', 'type'])
      expect(items[0].image, `${field} reached a domain that may not serve it`).not.toHaveProperty(
        field
      );
  });

  it('sends an above-ceiling asset on a domain that may serve it', async () => {
    const { items } = await ask({ nsfwLevel: NsfwLevel.X, domainLevels: allBrowsingLevelsFlag });

    expect(items[0].image).toMatchObject({ viewable: true, url: 'asset' });
  });

  it('marks what is outside the viewer band without withholding it', async () => {
    const { items } = await ask({
      nsfwLevel: NsfwLevel.R,
      domainLevels: allBrowsingLevelsFlag,
      viewerLevels: sfwBrowsingLevelsFlag,
    });

    expect(items[0].image).toMatchObject({
      viewable: true,
      withinViewerLevel: false,
      url: 'asset',
    });
  });
});
