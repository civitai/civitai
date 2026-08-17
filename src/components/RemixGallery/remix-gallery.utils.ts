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
  /**
   * When the owner approved it. Only approved entries reach this list, so this
   * is the moment the removal lock runs from — the manage modal needs it to say
   * how long is left rather than inferring a date from something else.
   */
  resolvedAt: Date | string | null;
  image: RemixGalleryImage;
};

/**
 * Flattens the infinite-query pages into one list, keeping the first occurrence
 * of each placement.
 *
 * The gallery cursor has already shipped one bug where pinned entries repeated
 * across pages, and a repeat here is not cosmetic: two cards would share a React
 * key, and the row-trimming below would count the duplicate toward a row it does
 * not fill. Deduping is one line and makes a server-side paging regression a
 * missing card rather than a crash.
 */
export function dedupeGalleryItems(items: RemixGalleryItem[]) {
  const seen = new Set<number>();
  return items.filter((item) =>
    seen.has(item.placementId) ? false : (seen.add(item.placementId), true)
  );
}

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

export type FreeSubmissionInputs = {
  /** The server resolved this remix as derived from the host image. */
  verified: boolean;
  /** What the creator accepts. `0` is them taking none — a setting, not a queue. */
  freeSlots: number;
  /** What is left right now. Stale by construction; the mutation re-counts. */
  freeSlotsRemaining: number;
  /** Free placements the placer has left today, across every surface. */
  allowanceRemaining: number;
  /** Free is once per gallery per placer, ever — not once per day. */
  usedHere: boolean;
};

/**
 * Whether the free option may be offered, and if not, why.
 *
 * Pure, and apart from the modal, because this is the part worth being sure
 * about: five inputs, an order that matters, and copy that is wrong in a
 * different way for each of them. Rendering it is the easy half.
 *
 * The order is most-specific-first, and `verified` leads deliberately. An
 * unverified remix is refused whatever the creator's slots say, so naming a slot
 * shortage there would send someone back tomorrow to be refused for the same
 * reason they were refused today.
 *
 * `reason` is `null` exactly when free is on offer, so a caller cannot render a
 * refusal and an offer at once.
 */
export function freeSubmissionOffer({
  verified,
  freeSlots,
  freeSlotsRemaining,
  allowanceRemaining,
  usedHere,
}: FreeSubmissionInputs): { available: boolean; reason: string | null } {
  if (!verified)
    return {
      available: false,
      reason:
        'Free submissions are for remixes made from this image here on the site, where we can check. Anything else can still be submitted with Buzz.',
    };

  if (usedHere)
    return {
      available: false,
      reason:
        "You've already used a free submission on this gallery. Free is once per gallery, not once a day.",
    };

  if (allowanceRemaining <= 0)
    return {
      available: false,
      reason: "You've used today's free placement. It comes back at midnight UTC.",
    };

  // The two states behind `freeSlotsRemaining: 0`, told apart by reading
  // `freeSlots` beside it — the resolver short-circuits the reservation count at
  // zero capacity, so the number alone cannot say which one this is. One is a
  // decision the creator made and the other is a queue that will move.
  if (freeSlots <= 0)
    return { available: false, reason: "This creator doesn't take free submissions." };

  if (freeSlotsRemaining <= 0)
    return { available: false, reason: 'The free slots on this image are all taken right now.' };

  return { available: true, reason: null };
}
