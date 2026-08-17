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
  /**
   * When the allowance comes back, from `getFreePlacementAllowance` rather than
   * a sentence written here. The reset is midnight UTC today and that is a
   * server-side rule; a client that spells it out is asserting something it does
   * not own, and would keep asserting it after the rule moved.
   */
  resetsAt: Date | string;
};

/**
 * When the allowance returns, in the reader's own timezone.
 *
 * Not "midnight UTC": that is true of the rule and misleading to a person, for
 * whom the boundary lands at some ordinary hour of their own day. Derived from
 * the server's date either way, so nothing here has to stay correct on its own.
 */
const allowanceResetLabel = (resetsAt: Date | string) =>
  new Date(resetsAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Whether the free option may be offered, and if not, why.
 *
 * Pure, and apart from the modal, because this is the part worth being sure
 * about: five inputs, an order that matters, and copy that is wrong in a
 * different way for each of them. Rendering it is the easy half.
 *
 * **The order is by how long each refusal lasts, longest first**, and every
 * adjacent pair is pinned by a test that makes both conditions true at once —
 * which is the only way an ordering can be asserted at all.
 *
 * Permanent for this image (`verified`), then permanent for this gallery
 * (`usedHere`), then the creator's own setting (`freeSlots`), then today
 * (`allowanceRemaining`), then right now (`freeSlotsRemaining`). Getting this
 * backwards is not a cosmetic problem: "it comes back at midnight UTC" told to
 * someone whose real obstacle is a creator taking no free submissions is a
 * promise about a gallery that will never accept one, and they will come back
 * tomorrow to be refused for the reason nobody named today.
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
  resetsAt,
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

  // Above the allowance, because this one never lifts: a creator who takes no
  // free submissions will not start at midnight. The two states behind
  // `freeSlotsRemaining: 0` are told apart by reading `freeSlots` beside it —
  // the resolver short-circuits the reservation count at zero capacity, so the
  // number alone cannot say which one this is.
  if (freeSlots <= 0)
    return { available: false, reason: "This creator doesn't take free submissions." };

  // ⚠️ `~/components/Sticker/free-offer.ts` (`freeRefusalMessage`) says the same
  // thing about the same number, written independently — the allowance is one
  // count across every surface. Deliberately not shared: the two ladders order
  // their reasons differently, and that ordering is what decides which sentence
  // a person sees, so a shared module would have to hold the ordering too.
  // Change this wording and change its twin. Its twin still spells out "midnight
  // UTC" rather than reading `resetsAt`; that is the same fix as this one.
  if (allowanceRemaining <= 0)
    return {
      available: false,
      reason: `You've used today's free placement. It comes back at ${allowanceResetLabel(
        resetsAt
      )}.`,
    };

  if (freeSlotsRemaining <= 0)
    return { available: false, reason: 'The free slots on this image are all taken right now.' };

  return { available: true, reason: null };
}

/**
 * Whether a re-read explains a free submission that was just refused — and
 * `null` when it does not.
 *
 * **The null is the whole point.** `freeSubmissionOffer` always has an answer,
 * because the caller hands it every input it needs; asked *after* a refusal it
 * therefore always sounds certain, and a caller consulting it will always
 * believe it. But the free path is refused for at least a dozen reasons this
 * function cannot see — an unverified remix, a duplicate entry, an unpublished
 * image, the content rule, a block or a moderator suspension — and a shape that
 * cannot say "I don't know" turns every one of those into whatever rung happens
 * to be lowest.
 *
 * So: re-read, ask again, and if the fresh numbers say free was still on offer,
 * the refusal was not about capacity and this returns nothing. What to do with
 * that is `freeRefusalOutcome`'s decision, not this one's.
 */
export const freeRefusalExplanation = (fresh: FreeSubmissionInputs) =>
  freeSubmissionOffer(fresh).reason;

/**
 * What to tell someone whose free submission was refused, and whether to move
 * the control to paid.
 *
 * Falling back is its own decision rather than a consequence of having a
 * message, because settling the control on paid **asserts that money was the
 * problem**. That is true of every rung above — each one is a limit on free
 * capacity that Buzz is not subject to — and false of everything the re-read
 * could not explain: a blocked or suspended placer who is quietly moved to the
 * paid button presses it and meets the same refusal, having been told the
 * opposite of what is wrong.
 *
 * Pure, so both halves are testable without a query client, and so the modal
 * holds no policy about which refusals money solves.
 */
export function freeRefusalOutcome(explained: string | null, serverMessage: string) {
  // `!== null`, not truthiness. They agree today only because every rung returns
  // a sentence; a rung that ever returned an empty string would silently take
  // the server branch, which is the branch that says "we could not explain this".
  if (explained !== null)
    return { title: 'That free slot got away', message: explained, fallBackToPaid: true };

  // The server's own words, unedited. It is the only party that knows, and
  // guessing here is what produced a modal that told everyone they lost a race.
  return { title: "Couldn't submit that", message: serverMessage, fallBackToPaid: false };
}
