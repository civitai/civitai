import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementService from '~/server/services/placement.service';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { dbMock } from '~/__tests__/mocks/db.mock';

const spaceFindUnique = dbMock.dbWrite.placementSpace.findUnique;
const spaceFindMany = dbMock.dbWrite.placementSpace.findMany;
const spaceUpsert = dbMock.dbWrite.placementSpace.upsert;
const imageFindUnique = dbMock.dbWrite.image.findUnique;

vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({
    min: 0,
    max: 500,
    freeSlotCap: capState.freeSlotCap,
    score: 0,
    tier: 'free' as const,
  }),
}));

const capState = { freeSlotCap: 4 };

const { resolvePlacementSpaceFor, setPlacementSpace } = await import(
  '~/server/services/placement-space.service'
);

const OWNER = 7;
const base = {
  surface: 'sticker' as const,
  entityType: 'user' as const,
  entityId: OWNER,
  userId: OWNER,
};

/** The row this level already has, as the service will read it. */
const storedRow = (price: number | null) => spaceFindUnique.mockResolvedValue({ price });
/** Rows at the levels above, as `inheritedPrice` will read them. */
const levelsAbove = (rows: { entityType: string; price: number | null }[]) =>
  spaceFindMany.mockResolvedValue(rows);

const priceWritten = () => spaceUpsert.mock.calls[0]?.[0]?.update;

beforeEach(() => {
  vi.clearAllMocks();
  spaceFindUnique.mockResolvedValue(null);
  spaceFindMany.mockResolvedValue([]);
  spaceUpsert.mockResolvedValue({});
  // Both the ownership check and `inheritedPrice` read the image through this
  // one call, selecting different columns.
  imageFindUnique.mockResolvedValue({ userId: OWNER, postId: 99 });
});

describe('setPlacementSpace — the price guard', () => {
  // The default rescues the guard; it must not be written to the row. Stamping
  // it would freeze today's platform price into every space created before it
  // next changes, and a later change would never reach them.
  it('opens a space with no price of its own without storing the default', async () => {
    await setPlacementSpace({ ...base, mode: 'review' });

    expect(spaceUpsert).toHaveBeenCalledTimes(1);
    expect(spaceUpsert.mock.calls[0][0].create).toMatchObject({ price: null });
    expect(spaceUpsert.mock.calls[0][0].update).not.toHaveProperty('price');
  });

  // A row whose price is null is the ordinary result of the case above, so the
  // clear-guard has to tell "no price to protect" from "no row".
  it('allows clearing an account price that is already null', async () => {
    storedRow(null);

    await setPlacementSpace({ ...base, mode: 'review', price: null });

    expect(priceWritten()).toMatchObject({ price: null });
  });

  // The whole point of the item: mode and price are one decision. A surface
  // with no default price must still refuse to open unpriced.
  it('still refuses to open a surface that has no default price', async () => {
    // Every surface in the table now carries a default, so this path is
    // currently unreachable through real data — `remixGallery` used to be the
    // example and stopped being one when galleries went default-on. The guard
    // still has to work for whatever surface is added next, so the absence is
    // staged here rather than the test being deleted along with the protection.
    const original = PLACEMENT_SURFACES.remixGallery.defaultPrice;
    (PLACEMENT_SURFACES.remixGallery as { defaultPrice: number | null }).defaultPrice = null;

    try {
      await expect(
        setPlacementSpace({ ...base, surface: 'remixGallery', mode: 'review' })
      ).rejects.toThrow(/set a price/);

      expect(spaceUpsert).not.toHaveBeenCalled();
    } finally {
      (PLACEMENT_SURFACES.remixGallery as { defaultPrice: number | null }).defaultPrice = original;
    }
  });

  // Clearing an account price is a deliberate act now that no control can emit
  // an empty value by accident, and the row must end up genuinely unset rather
  // than stamped with today's default -- an unset price follows the platform
  // default when it changes, a stored one freezes it.
  it('clears a stored account price to null rather than to the surface default', async () => {
    storedRow(500);

    await setPlacementSpace({ ...base, mode: 'review', price: null });

    expect(spaceUpsert).toHaveBeenCalledTimes(1);
    // `toMatchObject`, not `toBe(null)`: the helper returns the whole `update`
    // clause, and a bare null assertion passes for the wrong reason if the key
    // is omitted entirely -- which is what `undefined` writes.
    expect(priceWritten()).toMatchObject({ price: null });
  });

  // The refusal is account-level only. Below it "the level above" is a real
  // place, and the surface default is a legitimate thing to fall back to.
  it('allows clearing an image price even with no account price above it', async () => {
    storedRow(500);
    levelsAbove([]);

    await setPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: 42,
      userId: OWNER,
      mode: 'review',
      price: null,
    });

    expect(priceWritten()).toMatchObject({ price: null });
  });

  it('allows closing an account space while clearing its price', async () => {
    storedRow(500);

    await setPlacementSpace({ ...base, mode: 'off', price: null });

    expect(priceWritten()).toMatchObject({ price: null, mode: 'off' });
  });

  it('allows clearing a price that has a level above it to inherit', async () => {
    storedRow(500);
    levelsAbove([{ entityType: 'user', price: 250 }]);

    await setPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: 42,
      userId: OWNER,
      mode: 'review',
      price: null,
    });

    expect(priceWritten()).toMatchObject({ price: null });
  });

  it('leaves a stored price alone when none is sent', async () => {
    storedRow(500);

    await setPlacementSpace({ ...base, mode: 'review' });

    expect(priceWritten()).not.toHaveProperty('price');
  });

  // Sticker's default would mask this, so it is pinned on the surface that has
  // none: sending no price must mean "leave mine alone", not "I have none".
  it('reads the level’s own stored price when none is sent', async () => {
    storedRow(300);

    await setPlacementSpace({ ...base, surface: 'remixGallery', mode: 'review' });

    expect(spaceUpsert).toHaveBeenCalledTimes(1);
  });

  it('turning a space off never demands a price', async () => {
    await setPlacementSpace({ ...base, surface: 'remixGallery', mode: 'off' });

    expect(spaceUpsert).toHaveBeenCalledTimes(1);
  });

  it('refuses a space on someone else’s account', async () => {
    await expect(
      setPlacementSpace({ ...base, entityId: OWNER + 1, mode: 'review' })
    ).rejects.toThrow(/not your account/);

    expect(spaceUpsert).not.toHaveBeenCalled();
  });

  it('agrees with the cascade: a surface default rescues an unpriced open space', () => {
    // Stated as an assertion rather than a comment so it moves with the table.
    //
    // Both surfaces carry a default now. Galleries went default-on, and mode and
    // price are one decision — an open surface with no default price puts an
    // inviting space on every image and refuses every placement into it.
    expect(PLACEMENT_SURFACES.sticker.defaultPrice).not.toBeNull();
    expect(PLACEMENT_SURFACES.remixGallery.defaultPrice).not.toBeNull();
  });

  it('opens a remix gallery without a price, because the surface has a default', () => {
    // The pairing that makes default-on coherent: a creator who has never
    // touched their settings is open at the surface default, and the guard that
    // refuses an unpriced open space must not fire on them.
    expect(PLACEMENT_SURFACES.remixGallery.defaultMode).toBe('review');
    expect(PLACEMENT_SURFACES.remixGallery.defaultPrice).not.toBeNull();
    // At or above the floor, not equal to it. The floor is the spam gate; the
    // default is what a slot is worth. A default below the floor would be a
    // price the mutation refuses, which is the unreachable state this pairing
    // exists to prevent.
    expect(PLACEMENT_SURFACES.remixGallery.defaultPrice!).toBeGreaterThanOrEqual(
      PLACEMENT_SURFACES.remixGallery.serverMinPrice
    );
  });
});

describe('resolvePlacementSpaceFor — free capacity', () => {
  // `dbRead`: the reservation feeds a display-only number on a public query, and
  // the claim re-counts under its own lock. Everything else in this resolver
  // reads the primary because it decides a mutation.
  const placementCount = dbMock.dbRead.placement.count;

  const resolve = () =>
    resolvePlacementSpaceFor({ surface: 'sticker', targetType: 'image', targetId: 42 });

  beforeEach(() => {
    capState.freeSlotCap = 4;
    imageFindUnique.mockResolvedValue({
      id: 42,
      userId: OWNER,
      postId: null,
      user: { username: 'creator' },
    });
    placementCount.mockResolvedValue(0);
  });

  it('gives an unconfigured space the surface default', async () => {
    const space = await resolve();

    expect(space.setFreeSlots).toBe(PLACEMENT_SURFACES.sticker.defaultFreeSlots);
    expect(space.freeSlots).toBe(PLACEMENT_SURFACES.sticker.defaultFreeSlots);
    expect(space.freeSlotsRemaining).toBe(PLACEMENT_SURFACES.sticker.defaultFreeSlots);
  });

  it('subtracts what is already reserved', async () => {
    spaceFindMany.mockResolvedValue([
      { entityType: 'image', mode: 'review', price: 100, freeSlots: 4 },
    ]);
    placementCount.mockResolvedValue(3);

    expect((await resolve()).freeSlotsRemaining).toBe(1);
  });

  // Both statuses, and free rows only. A count that took every status would never
  // release a slot after a decline; one that ignored `free` would let paid
  // placements eat the free capacity, which the two counters exist to keep apart.
  it('reserves against pending and approved free rows, and nothing else', async () => {
    spaceFindMany.mockResolvedValue([
      { entityType: 'image', mode: 'review', price: 100, freeSlots: 4 },
    ]);

    await resolve();

    const { where } = placementCount.mock.calls[0][0];
    expect(where).toMatchObject({
      surface: 'sticker',
      targetType: 'image',
      targetId: 42,
      free: true,
    });
    expect(where.status.in.slice().sort()).toEqual(['approved', 'pending']);
  });

  it('never reports negative room when the owner lowers their slider', async () => {
    // Not a takeback: the placements they already accepted stay, and the space
    // simply accepts nothing further until one is released.
    spaceFindMany.mockResolvedValue([
      { entityType: 'image', mode: 'review', price: 100, freeSlots: 1 },
    ]);
    placementCount.mockResolvedValue(3);

    expect((await resolve()).freeSlotsRemaining).toBe(0);
  });

  it('ceilings a stored count at the cap without rewriting the row', async () => {
    capState.freeSlotCap = 2;
    spaceFindMany.mockResolvedValue([
      { entityType: 'image', mode: 'review', price: 100, freeSlots: 9 },
    ]);

    const space = await resolve();

    expect(space.setFreeSlots).toBe(9);
    expect(space.freeSlots).toBe(2);
  });

  it('asks nothing of the database when the space takes no free placements', async () => {
    spaceFindMany.mockResolvedValue([
      { entityType: 'image', mode: 'review', price: 100, freeSlots: 0 },
    ]);

    const space = await resolve();

    expect(space.freeSlotsRemaining).toBe(0);
    // The answer is 0 whatever the count says, so the query is a round trip that
    // cannot change it.
    expect(placementCount).not.toHaveBeenCalled();
  });
});

describe('setPlacementSpace — free slots', () => {
  // The same three-way distinction as the price, and it has to be, because the
  // per-image toggle sends `mode` and `price` and nothing else: without this an
  // owner flipping one image on would silently clear their account-level count.
  it('leaves a stored count alone when none is sent', async () => {
    await setPlacementSpace({ ...base, mode: 'review' });

    expect(priceWritten()).not.toHaveProperty('freeSlots');
  });

  /**
   * The `create` half, which every other test here reads past — `priceWritten()`
   * is the `update` clause.
   *
   * This is the first-ever save for a space, and it is the likeliest place for
   * the freeze-the-default failure to land: `freeSlots: freeSlots ?? 0` in the
   * create clause writes an explicit `0` for a creator who has expressed no
   * preference, permanently opting the space out of tracking the surface default
   * AND closing it. Every assertion on the `update` side stays green.
   */
  it('creates a first-ever row with no count of its own, not with a zero', async () => {
    await setPlacementSpace({ ...base, mode: 'review' });

    expect(spaceUpsert.mock.calls[0][0].create).toMatchObject({ freeSlots: null });
  });

  it('creates with the count when the creator did choose one', async () => {
    await setPlacementSpace({ ...base, mode: 'review', freeSlots: 0 });

    expect(spaceUpsert.mock.calls[0][0].create).toMatchObject({ freeSlots: 0 });
  });

  it('clears a count to null so the level inherits again', async () => {
    await setPlacementSpace({ ...base, mode: 'review', freeSlots: null });

    expect(priceWritten()).toMatchObject({ freeSlots: null });
  });

  // Stored uncapped, exactly as the price is. A creator whose tier lapses and
  // returns gets their number back rather than finding it silently rewritten to
  // whatever their cap happened to be on the day they last saved.
  it('stores a count above the current cap rather than refusing or clamping it', async () => {
    await setPlacementSpace({ ...base, mode: 'review', freeSlots: 9 });

    expect(priceWritten()).toMatchObject({ freeSlots: 9 });
  });

  // The state that replaces an on/off toggle. Written through, not treated as
  // "unset", or the creator's no would resolve back to the surface default.
  it('stores an explicit zero', async () => {
    await setPlacementSpace({ ...base, mode: 'review', freeSlots: 0 });

    expect(priceWritten()).toMatchObject({ freeSlots: 0 });
  });
});
