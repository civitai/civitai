import { describe, expect, it } from 'vitest';
import type { RemixGalleryItem } from '~/components/RemixGallery/remix-gallery.utils';
import {
  dedupeGalleryItems,
  freeSubmissionOffer,
  galleryDialogImages,
  trimToWholeRows,
} from '~/components/RemixGallery/remix-gallery.utils';

describe('freeSubmissionOffer', () => {
  /** Everything satisfied, so each case below breaks exactly one thing. */
  const eligible = {
    verified: true,
    freeSlots: 3,
    freeSlotsRemaining: 2,
    allowanceRemaining: 1,
    usedHere: false,
  };

  it('offers free when every condition holds', () => {
    expect(freeSubmissionOffer(eligible)).toEqual({ available: true, reason: null });
  });

  it('never returns a reason alongside an offer', () => {
    // The two are read by different bits of the card, so a state carrying both
    // would render a refusal under a working free button.
    const offer = freeSubmissionOffer(eligible);
    expect(offer.available).toBe(offer.reason === null);
  });

  it('refuses an unverified remix and names paying as the alternative', () => {
    const { available, reason } = freeSubmissionOffer({ ...eligible, verified: false });

    expect(available).toBe(false);
    expect(reason).toMatch(/with Buzz/i);
    // It must not call an off-site remix "not a remix": that is both wrong and
    // an accusation, and it is the case a submitter is most likely to hit on
    // work they know they made.
    expect(reason).not.toMatch(/not a remix|isn't a remix/i);
  });

  it('leads with verification even when a slot shortage is also true', () => {
    // Order is the whole design here. Naming the shortage would send someone
    // back tomorrow to be refused for the reason they were refused today.
    const { reason } = freeSubmissionOffer({
      ...eligible,
      verified: false,
      freeSlotsRemaining: 0,
      allowanceRemaining: 0,
      usedHere: true,
    });

    expect(reason).toMatch(/where we can check/i);
  });

  it('tells the two meanings of "no slots remaining" apart', () => {
    // `freeSlotsRemaining: 0` covers both "this creator takes none" and "they
    // are all held right now" — the resolver short-circuits the count at zero
    // capacity — and the difference decides whether coming back later helps.
    const takesNone = freeSubmissionOffer({ ...eligible, freeSlots: 0, freeSlotsRemaining: 0 });
    const allHeld = freeSubmissionOffer({ ...eligible, freeSlots: 3, freeSlotsRemaining: 0 });

    expect(takesNone.reason).toMatch(/doesn't take free/i);
    expect(allHeld.reason).toMatch(/all taken right now/i);
    expect(takesNone.reason).not.toBe(allHeld.reason);
  });

  it('separates a spent daily allowance from a gallery already used', () => {
    // One comes back at midnight and the other never does, so a single message
    // for both would tell half of them to wait for something that will not
    // happen.
    expect(freeSubmissionOffer({ ...eligible, allowanceRemaining: 0 }).reason).toMatch(
      /midnight UTC/i
    );
    expect(freeSubmissionOffer({ ...eligible, usedHere: true }).reason).toMatch(
      /once per gallery/i
    );
  });
});

const items = (count: number, startId = 1) =>
  Array.from({ length: count }, (_, index) => ({
    placementId: startId + index,
    placerId: 1,
    pinned: false,
    image: { id: startId + index },
  })) as unknown as RemixGalleryItem[];

describe('dedupeGalleryItems', () => {
  it('keeps the first occurrence when a page repeats a placement', () => {
    // The server has already shipped one cursor bug that returned a pinned
    // entry on two consecutive pages. Two cards would then share a React key,
    // and the row trimming below would count the duplicate toward a row it does
    // not fill.
    const [a, b] = items(2);
    expect(dedupeGalleryItems([a, b, a]).map((item) => item.placementId)).toEqual([1, 2]);
  });

  it('leaves a page with no repeats untouched', () => {
    const page = items(4);
    expect(dedupeGalleryItems(page)).toEqual(page);
  });

  it('returns nothing for an empty gallery', () => {
    expect(dedupeGalleryItems([])).toEqual([]);
  });
});

describe('trimToWholeRows', () => {
  it('drops a partial trailing row', () => {
    expect(trimToWholeRows([1, 2, 3, 4, 5, 6], 4)).toEqual([1, 2, 3, 4]);
  });

  it('keeps an exact number of rows intact', () => {
    expect(trimToWholeRows([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // The regression this exists for: trimming a below-one-row gallery to whole
  // rows empties it, which hides every gallery that has fewer entries than one
  // row — i.e. every gallery on its first day.
  it('keeps a partial row when it is the only row', () => {
    expect(trimToWholeRows([1, 2], 4)).toEqual([1, 2]);
    expect(trimToWholeRows([1], 4)).toEqual([1]);
  });

  it('returns nothing for an empty gallery', () => {
    expect(trimToWholeRows([], 4)).toEqual([]);
  });
});

describe('galleryDialogImages', () => {
  it('returns the gallery images so the dialog browses the gallery', () => {
    const result = galleryDialogImages(2, items(3));
    expect(result.map((image) => image.id)).toEqual([1, 2, 3]);
  });

  // An empty set makes the dialog fall back to its own query, which browses the
  // feed behind the gallery instead of the gallery.
  it('returns an empty window when the image is not in the set', () => {
    expect(galleryDialogImages(99, items(3))).toEqual([]);
  });

  it('windows a large gallery around the clicked image', () => {
    const result = galleryDialogImages(120, items(300));
    expect(result).toHaveLength(100);
    expect(result[0].id).toBe(70);
    expect(result[result.length - 1].id).toBe(169);
  });
});
