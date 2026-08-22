import { describe, expect, it } from 'vitest';
import { chunkStickerIds } from '~/components/Sticker/sticker.util';
import { STICKER_OFFER_LIMIT } from '~/server/schema/cosmetic.schema';

/**
 * Every id must reach a request.
 *
 * 🔴 THE BUG THIS REPLACES WAS A `slice`. `useStickerRefill` asked for offers on
 * `owned.slice(0, STICKER_OFFER_LIMIT)`, so an account past that cap got no offer
 * for the rest — which renders as "this sticker sells no extra uses", permanently,
 * on the stickers they bought most recently. One account on production owns 126.
 *
 * A truncation is invisible from inside: the query succeeds, the map is populated,
 * every lookup that happens to be for an early id works. So the property to hold is
 * total coverage, asserted against an input larger than one chunk.
 */
describe('chunkStickerIds', () => {
  const ids = Array.from({ length: STICKER_OFFER_LIMIT * 2 + 7 }, (_, i) => 1000 - i);

  it('puts every id in exactly one chunk, however many there are', () => {
    const flat = chunkStickerIds(ids, STICKER_OFFER_LIMIT).flat();

    expect(flat).toHaveLength(ids.length);
    expect(new Set(flat).size).toBe(ids.length);
    expect(flat).toEqual(ids);
  });

  it('never hands the endpoint more ids than it accepts', () => {
    for (const chunk of chunkStickerIds(ids, STICKER_OFFER_LIMIT))
      expect(chunk.length).toBeLessThanOrEqual(STICKER_OFFER_LIMIT);
  });

  it('keeps insertion order, so a growing list does not reshuffle the keys it has', () => {
    const first = chunkStickerIds([5, 4, 3], 2);
    const grown = chunkStickerIds([5, 4, 3, 2, 1], 2);

    // The chunks already fetched are still the same chunks — a sorted derivation
    // would slide 2 and 1 into the front and change every key after them.
    expect(grown[0]).toEqual(first[0]);
    expect(grown.slice(0, first.length - 1)).toEqual(first.slice(0, first.length - 1));
  });

  it('dedupes, because two drafts of one sticker are one question', () => {
    expect(chunkStickerIds([7, 7, 8, 7], STICKER_OFFER_LIMIT)).toEqual([[7, 8]]);
  });

  it('asks nothing when nothing is drafted', () => {
    expect(chunkStickerIds([], STICKER_OFFER_LIMIT)).toEqual([]);
  });
});
