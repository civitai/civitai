import { describe, expect, it } from 'vitest';
import { chunkStickerIds, draftedCosmeticIds } from '~/components/Sticker/sticker.util';
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
    const chunks = chunkStickerIds(ids, STICKER_OFFER_LIMIT);

    // Asserted before the loop: a `for … expect` over an empty array makes no
    // assertions at all and still reports green.
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(STICKER_OFFER_LIMIT);
  });

  it('keeps insertion order, so a growing list does not reshuffle the keys it has', () => {
    // 🔴 DELIBERATELY NOT MONOTONIC. Every id here is out of numeric order, so a
    // sorted derivation cannot coincide with the expected result — with a
    // descending fixture, `sort((a, b) => b - a)` passes this test unchanged.
    const first = chunkStickerIds([5, 9, 3, 7, 1], 2);
    const grown = chunkStickerIds([5, 9, 3, 7, 1, 8, 2], 2);

    expect(first).toEqual([[5, 9], [3, 7], [1]]);
    // Two COMPLETE chunks compared, not one: the claim is that boundaries
    // already fetched do not move when the list grows.
    expect(grown.slice(0, 2)).toEqual(first.slice(0, 2));
  });

  it('dedupes, because two drafts of one sticker are one question', () => {
    expect(chunkStickerIds([7, 7, 8, 7], STICKER_OFFER_LIMIT)).toEqual([[7, 8]]);
  });

  it('asks nothing when nothing is drafted', () => {
    expect(chunkStickerIds([], STICKER_OFFER_LIMIT)).toEqual([]);
  });
});

/**
 * `draft.id` and `draft.cosmeticId` are both numbers on the same object, so
 * swapping them typechecks — and every draft then reads "this sticker sells no
 * extra uses" forever, which is the shipped bug's own symptom one layer up.
 */
describe('draftedCosmeticIds', () => {
  it('reads the cosmetic, not the draft', () => {
    expect(draftedCosmeticIds([{ id: 11, cosmeticId: 7 } as never])).toEqual([7]);
  });

  it('keeps one entry per draft, in the order they were laid down', () => {
    const drafts = [{ cosmeticId: 7 }, { cosmeticId: 9 }, { cosmeticId: 7 }];

    // Deduping is the query hook's job, not this one's: two drafts of one sticker
    // are two drafts, and the layer indexes gates by draft.
    expect(draftedCosmeticIds(drafts)).toEqual([7, 9, 7]);
  });
});
