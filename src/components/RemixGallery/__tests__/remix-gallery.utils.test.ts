import { describe, expect, it } from 'vitest';
import type { RemixGalleryItem } from '~/components/RemixGallery/remix-gallery.utils';
import {
  dedupeGalleryItems,
  galleryDialogImages,
  trimToWholeRows,
} from '~/components/RemixGallery/remix-gallery.utils';

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
