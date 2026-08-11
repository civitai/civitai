import type { ImageGetInfinite } from '~/types/router';
import { REMIX_GALLERY_ROW_WIDTH } from '~/shared/utils/remix-gallery';

/**
 * A full feed image rather than a projection: entries are handed straight to
 * the image-detail dialog, which browses the set it is given instead of running
 * its own query, and it will not accept a narrower shape.
 */
export type RemixGalleryImage = ImageGetInfinite[number];

export type RemixGalleryItem = {
  placementId: number;
  placerId: number;
  pinned: boolean;
  image: RemixGalleryImage;
};

/**
 * Trims a rendered page to whole rows so the grid never ends with a dangling
 * card in a half-empty row.
 *
 * A partial row is kept when it is the *only* row — a gallery with two entries
 * shows two, not none. Trimming that away would hide the entire gallery of
 * anyone who has fewer entries than one row, which is every gallery on its
 * first day.
 */
export function trimToWholeRows<T>(items: T[], rowWidth = REMIX_GALLERY_ROW_WIDTH) {
  if (items.length < rowWidth) return items;
  return items.slice(0, Math.floor(items.length / rowWidth) * rowWidth);
}

/**
 * The window of images handed to the image-detail dialog so it browses the
 * gallery rather than the feed behind it.
 *
 * Mirrors `ImagesCard`'s `getDialogState`: passing images at all is what makes
 * the detail view skip its own query, and the window keeps the payload bounded
 * on a gallery that has paged in a few hundred entries.
 */
export function galleryDialogImages(imageId: number, items: RemixGalleryItem[]) {
  const images = items.map((item) => item.image);
  const index = images.findIndex((image) => image.id === imageId);
  if (index === -1) return [];
  return images.slice(Math.max(index - 50, 0), index + 50);
}
