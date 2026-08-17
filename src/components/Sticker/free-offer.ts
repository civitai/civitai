/**
 * Whether the free offer is on the table, and what it says.
 *
 * Its own module with no imports, for the same reason `payout-copy.ts` is one:
 * these are the branches most worth testing and the least worth dragging
 * Mantine, tRPC and the edge image loader into a unit run to reach.
 *
 * The predicate lives here rather than at each of the three places that need it
 * — the button's tray, the draft layer, and the draft itself — because three
 * copies of a three-term condition is how one of them starts offering free where
 * the others do not.
 */

/**
 * The free offer, or `null` when paid is the only one.
 *
 * All three facts have to hold, and each is a different reason to be looking at
 * the paid button: the creator may take no free stickers or have none left, the
 * placer may have spent their day, or they may have already placed free on this
 * image. Missing any one of them offers something the claim then refuses.
 *
 * `null` while either query is in flight, which shows the paid button first and
 * adds the choice when it lands. The other order offers free and takes it away.
 *
 * ⚠️ Both inputs are display state and stale the moment they arrive. This picks
 * which offer to SHOW; `createFreePlacement` decides whether one is allowed,
 * under a lock, in the transaction that inserts.
 */
export function freeOfferFor(
  space?: FreeCapacity & { mode?: string },
  standing?: FreeStanding
): { instant: boolean } | null {
  if (!space || !standing) return null;
  if (space.freeSlotsRemaining <= 0) return null;
  if (standing.remaining <= 0 || standing.usedHere) return null;

  return { instant: space.mode === 'auto' };
}

/**
 * Which offer is selected, defaulting to free whenever one is available.
 *
 * `null` means nobody has pressed the control, and that is what makes the
 * default work: the offer arrives with a query, so a value chosen on the first
 * render would be paid and would stay paid once the real answer landed.
 *
 * Paid placements never consume free slots, so both can be genuinely available
 * at once — this is a choice, not a fallback.
 */
export const isPlacingFree = (chosen: 'free' | 'paid' | null, offer: { instant: boolean } | null) =>
  (chosen ?? (offer ? 'free' : 'paid')) === 'free' && !!offer;

/**
 * The free option's own label, which carries the mode.
 *
 * The mode goes here rather than on the sticker button because this is the last
 * moment the placer can change their mind, and it makes auto-accept and review
 * read as two different offers rather than one setting they cannot see. The
 * button upstream stays a single number.
 */
export const freeOptionLabel = (instant: boolean) =>
  instant ? 'Free · instant' : 'Free · needs review';

/**
 * The one line under a review-mode free option.
 *
 * Said before the press, not after, because it is the whole asymmetry of the
 * free tier: the image's slot comes back when a creator declines and the
 * placer's day does not. Somebody who would rather spend Buzz on a creator who
 * reviews needs that fact while both options are still on screen.
 */
export const FREE_REVIEW_CAVEAT =
  "Your free placement for today is spent even if they decline. The creator's slot comes back; your allowance does not.";

/**
 * What went wrong when a free claim was refused, from state re-read after the
 * refusal rather than from the server's message.
 *
 * The numbers the control renders are stale by construction — the claim
 * re-counts under a lock — so losing the last slot to someone else is an
 * ordinary outcome rather than an error, and it deserves a sentence written for
 * the person reading it. Re-reading first is what makes the sentence true: the
 * refusal itself does not say which of the three rules stopped it, and guessing
 * from its text would be a client parsing prose the server is free to reword.
 *
 * Ordered by how specific each fact is, so the most useful true thing wins. The
 * last branch covers a refusal the re-read cannot explain — a block, a
 * suspension, the creator closing the space — where saying only what is certain
 * beats naming a cause we do not have.
 */
export function freeRefusalMessage(standing?: FreeStanding, space?: FreeCapacity) {
  if (standing?.usedHere) return 'You have already used a free sticker on this image.';
  if (standing && standing.remaining <= 0)
    return "You have used today's free placement. It comes back at midnight UTC.";
  if (space && space.freeSlots > 0 && space.freeSlotsRemaining <= 0)
    return 'Someone took the last free slot on this image first.';
  if (space && space.freeSlots <= 0)
    return 'This creator is not taking free stickers on this image.';
  return 'That free slot could not be claimed.';
}

type FreeStanding = { remaining: number; usedHere: boolean };
type FreeCapacity = { freeSlots: number; freeSlotsRemaining: number };
