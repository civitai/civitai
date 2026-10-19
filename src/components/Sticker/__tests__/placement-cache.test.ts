import { describe, expect, it } from 'vitest';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import {
  decrementPlacementCount,
  dropPlacementFromBundle,
  dropPlacementFromList,
  resolveStickerCounts,
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
  data: { cosmeticId: 900, x: 0.5, y: 0.5, scale: 0.2, rotation: 0, flip: false, opacity: 1 },
  placedAt: new Date('2026-08-12T12:00:00Z'),
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

describe('dropping a removed placement out of a cached combined response', () => {
  const bundle = { placements: [APPROVED, PENDING, OTHER], counts: { 8100: 4, 8102: 9 } };

  it('removes the row and takes it off that image’s count, in the same entry', () => {
    const result = dropPlacementFromBundle(bundle, APPROVED.id);

    expect(result.bundle?.placements.map((p) => p.id)).toEqual([PENDING.id, OTHER.id]);
    expect(result.bundle?.counts).toEqual({ 8100: 3, 8102: 9 });
    expect(result.countedOn).toBe(8100);
  });

  it('leaves the count alone for a pending row, which it never included', () => {
    const result = dropPlacementFromBundle(bundle, PENDING.id);

    expect(result.bundle?.placements.map((p) => p.id)).toEqual([APPROVED.id, OTHER.id]);
    expect(result.bundle?.counts).toEqual({ 8100: 4, 8102: 9 });
    expect(result.countedOn).toBeUndefined();
  });

  // A moderator's listing carries rows kept off the image, which the approved count never
  // included; removing one must not take a sticker off the badge.
  it('leaves the count alone for a kept-off row on a moderator’s listing', () => {
    const KEPT_OFF = { ...placement(5004, 8100), keptOff: true as const };
    const result = dropPlacementFromBundle(
      { placements: [APPROVED, KEPT_OFF], counts: { 8100: 4 } },
      KEPT_OFF.id
    );

    expect(result.bundle?.placements.map((p) => p.id)).toEqual([APPROVED.id]);
    expect(result.bundle?.counts).toEqual({ 8100: 4 });
    expect(result.countedOn).toBeUndefined();
  });

  it('writes nothing to an entry that did not hold the row', () => {
    expect(dropPlacementFromBundle(bundle, 9999)).toEqual({
      bundle: undefined,
      countedOn: undefined,
    });
    expect(dropPlacementFromBundle(undefined, APPROVED.id).bundle).toBeUndefined();
  });
});

describe('which call a surface reads its counts from', () => {
  const none = { data: undefined, isLoading: false, isError: false };
  const loading = { data: undefined, isLoading: true, isError: false };
  const failed = { data: undefined, isLoading: false, isError: true };
  const combined = { data: { 8100: 6 }, isLoading: false, isError: false };
  const countsOnly = { data: { 8100: 2 }, isLoading: false, isError: false };

  it('reads the combined call wherever placements are wanted', () => {
    expect(resolveStickerCounts({ wantPlacements: true, combined, countsOnly })).toEqual({
      counts: { 8100: 6 },
      isLoading: false,
      isError: false,
    });
  });

  it('reads the count-only call where they are not', () => {
    expect(resolveStickerCounts({ wantPlacements: false, combined, countsOnly })).toEqual({
      counts: { 8100: 2 },
      isLoading: false,
      isError: false,
    });
  });

  it('keeps an earlier count-only answer on screen while the combined call is in flight', () => {
    expect(resolveStickerCounts({ wantPlacements: true, combined: loading, countsOnly })).toEqual({
      counts: { 8100: 2 },
      isLoading: false,
      isError: false,
    });
  });

  it('reports the combined call’s loading and failure as the count’s, with nothing to fall back on', () => {
    expect(
      resolveStickerCounts({ wantPlacements: true, combined: loading, countsOnly: none })
    ).toEqual({ counts: {}, isLoading: true, isError: false });
    expect(
      resolveStickerCounts({ wantPlacements: true, combined: failed, countsOnly: none })
    ).toEqual({ counts: {}, isLoading: false, isError: true });
  });

  // A choice, pinned so it stays one: an answer already on screen is kept rather than replaced by
  // an error. A cached count-only answer exists only where the count-only call ran, which the bar
  // and the provider do only for a signed-out viewer (it is disabled for anyone signed in); the
  // bar's invitation also requires a signed-in viewer (`canPlace`), so it is not offered here.
  it('keeps an earlier count-only answer when the combined call fails', () => {
    expect(resolveStickerCounts({ wantPlacements: true, combined: failed, countsOnly })).toEqual({
      counts: { 8100: 2 },
      isLoading: false,
      isError: false,
    });
  });

  it('reports the count-only call’s failure where that is the call in use', () => {
    expect(resolveStickerCounts({ wantPlacements: false, combined, countsOnly: failed })).toEqual({
      counts: {},
      isLoading: false,
      isError: true,
    });
  });
});
