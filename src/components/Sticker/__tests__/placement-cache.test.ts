import { describe, expect, it } from 'vitest';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import {
  decrementPlacementCount,
  dropPlacementFromList,
} from '~/components/Sticker/placement.util';

/**
 * The cache patch a moderator removal applies instead of invalidating every
 * placement query on the page.
 *
 * These are the two rules that decide whether the reaction bar still agrees with
 * what is drawn afterwards, and they are pure so they can be checked without a
 * query client or a browser.
 */

const placement = (id: number, imageId: number, isPending = false): PlacedSticker => ({
  id,
  imageId,
  placerId: 601,
  ownerId: 602,
  status: isPending ? 'pending' : 'approved',
  amount: 75,
  data: { cosmeticId: 900, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  isPending,
});

const APPROVED = placement(5001, 8100);
const PENDING = placement(5002, 8101, true);
const OTHER = placement(5003, 8102);

describe('dropping a removed placement out of a cached list', () => {
  it('removes the row and reports the image whose count it was in', () => {
    const result = dropPlacementFromList([APPROVED, OTHER], APPROVED.id);

    expect(result.placements?.map((p) => p.id)).toEqual([OTHER.id]);
    expect(result.countedOn).toBe(8100);
  });

  // getStickerPlacementCounts is approved-only, so a pending row was never in
  // it. Decrementing for one leaves the badge a sticker short of what is drawn,
  // because the bar adds the viewer's own pending rows on top of the count.
  it('reports no image to decrement when the row was pending', () => {
    const result = dropPlacementFromList([PENDING, OTHER], PENDING.id);

    expect(result.placements?.map((p) => p.id)).toEqual([OTHER.id]);
    expect(result.countedOn).toBeUndefined();
  });

  // The updater runs against every cached chunk and all but one of them do not
  // hold the row. Returning the array back — even the same reference — makes
  // `setQueryData` write it and stamp a fresh `dataUpdatedAt`, which is what the
  // batch provider memoises on, so every chunk in the feed recomputes.
  // `undefined` is the only return it skips.
  it('returns undefined for a chunk that does not hold the row, so the write is skipped', () => {
    const chunk = [OTHER];
    const result = dropPlacementFromList(chunk, APPROVED.id);

    expect(result.placements).toBeUndefined();
    expect(chunk).toEqual([OTHER]);
    expect(result.countedOn).toBeUndefined();
  });

  it('survives a cache entry that has no data yet', () => {
    const result = dropPlacementFromList(undefined, APPROVED.id);

    expect(result.placements).toBeUndefined();
    expect(result.countedOn).toBeUndefined();
  });
});

describe('decrementing the count for that image', () => {
  it('takes one off the right image and leaves the others alone', () => {
    expect(decrementPlacementCount({ 8100: 3, 8102: 7 }, 8100)).toEqual({ 8100: 2, 8102: 7 });
  });

  // A count that is absent or already zero is not a count to take from — going
  // negative would render as "-1 stickers".
  it('refuses to go below zero, and ignores an image it has no count for', () => {
    expect(decrementPlacementCount({ 8100: 0 }, 8100)).toEqual({ 8100: 0 });
    expect(decrementPlacementCount({ 8102: 7 }, 8100)).toEqual({ 8102: 7 });
  });

  it('survives a cache entry that has no data yet', () => {
    expect(decrementPlacementCount(undefined, 8100)).toBeUndefined();
  });
});
