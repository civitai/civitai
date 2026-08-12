import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementService from '~/server/services/placement.service';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';

const spaceFindUnique = vi.fn();
const spaceFindMany = vi.fn();
const spaceUpsert = vi.fn();
const imageFindUnique = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {
    placementSpace: {
      findUnique: spaceFindUnique,
      findMany: spaceFindMany,
      upsert: spaceUpsert,
    },
    image: { findUnique: imageFindUnique },
    post: { findUnique: vi.fn() },
  },
}));

vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({ min: 0, max: 500, score: 0, tier: 'free' as const }),
}));

const { setPlacementSpace } = await import('~/server/services/placement-space.service');

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
    await expect(
      setPlacementSpace({ ...base, surface: 'remixGallery', mode: 'review' })
    ).rejects.toThrow(/set a price/);

    expect(spaceUpsert).not.toHaveBeenCalled();
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
    expect(PLACEMENT_SURFACES.sticker.defaultPrice).not.toBeNull();
    expect(PLACEMENT_SURFACES.remixGallery.defaultPrice).toBeNull();
  });
});
