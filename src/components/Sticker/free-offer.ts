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
 * refusal rather than from the server's message — or `null` when the re-read
 * does not explain it.
 *
 * The numbers the control renders are stale by construction — the claim
 * re-counts under a lock — so losing the last slot to someone else is an
 * ordinary outcome rather than an error, and it deserves a sentence written for
 * the person reading it. Re-reading is what makes the sentence true: the refusal
 * does not say which rule stopped it, and reading its text would be a client
 * parsing prose the server is free to reword.
 *
 * 🔴 **`null` is the important return.** A free placement can be refused for
 * plenty of reasons that have nothing to do with the free tier — a block, a
 * moderator suspension, self-placement, a sticker over the creator's size limit
 * — each with a message written for the person who hit it. Answering "someone
 * took the last slot" to any of those throws that message away and sends them to
 * a remedy that will not work. So this speaks only where it knows, and the
 * caller shows the server's own refusal otherwise.
 *
 * 🔴 **Ordered so a refusal that is PERMANENT for this image outranks one that
 * lifts by itself**, because more than one can be true at once and the first
 * match is what gets said. Telling somebody their allowance comes back at
 * midnight, when the real answer is that this creator takes no free stickers at
 * all, is a false promise about a specific image — they come back tomorrow to
 * the same refusal. The pairwise tests exist to hold this order: each sets both
 * conditions of an adjacent pair, so a swap fails rather than passing on
 * fixtures that only ever trip one rung.
 */
export function freeRefusalMessage(standing?: FreeStanding, space?: FreeCapacity) {
  // Permanent for this image, and true of everybody — so it outranks the two
  // below it, which are about this placer and about right now.
  if (space && space.freeSlots <= 0)
    return 'This creator is not taking free stickers on this image.';
  // Permanent for this placer on this image: once ever, not once per day.
  if (standing?.usedHere) return 'You have already used a free sticker on this image.';
  // Transient, and it says when it lifts — derived from the reset the server
  // computed rather than restating the boundary here.
  if (standing && standing.remaining <= 0)
    return `You have used today's free placement. It comes back ${allowanceResetLabel(
      standing.resetsAt
    )}.`;
  // The most transient of all — a declined placement releases its slot at once.
  if (space && space.freeSlotsRemaining <= 0)
    return 'Someone took the last free slot on this image first.';
  return null;
}

/**
 * What to say and what to do when a free claim was refused.
 *
 * Pure, and separate from `freeRefusalMessage`, because the consequential half is
 * not the wording — it is `fallBackToPaid`. Offering the paid button is right
 * when free specifically ran out and wrong when the whole placement was refused:
 * somebody who is blocked, suspended, or placing on their own image would press
 * it and meet the same refusal, having been told the problem was money.
 *
 * A hook cannot be asked this question without a query client and a tRPC
 * provider, so the decision lives here where a test can put both cases to it.
 */
export const freeRefusalOutcome = (explained: string | null, serverMessage: string) =>
  explained
    ? { title: 'That one has to be paid for', message: explained, fallBackToPaid: true }
    : { title: "Couldn't place that sticker", message: serverMessage, fallBackToPaid: false };

type FreeStanding = {
  remaining: number;
  usedHere: boolean;
  /**
   * When the allowance comes back. Computed by `getFreePlacementAllowance` and
   * shipped on every read — so a sentence that hardcodes the boundary is a second
   * copy of a rule the server already owns, and the two are free to disagree the
   * day the day-boundary or the per-day count moves.
   */
  resetsAt?: Date | string;
};
type FreeCapacity = { freeSlots: number; freeSlotsRemaining: number };

/**
 * When the daily allowance comes back, in words.
 *
 * Falls back to the boundary the server currently uses rather than saying nothing,
 * because a refusal that cannot say when it lifts is worse than one that names a
 * default — but the value is preferred, so changing the day boundary changes this
 * sentence instead of making it wrong.
 */
function allowanceResetLabel(resetsAt?: Date | string) {
  if (!resetsAt) return 'at midnight UTC';
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return 'at midnight UTC';

  return `at ${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * The tray's price line, which has to name both offers when both are open.
 *
 * The use is the constant: a free placement is free of the creator's price and of
 * nothing else. Saying so here is what stops the tray and the Place button
 * disagreeing about what a sticker costs.
 */
export const trayPriceLine = (freeAvailable: boolean, price: number) =>
  freeAvailable ? `Free, or ${price} Buzz · one use either way` : `${price} Buzz + one use`;

/**
 * What the tray says a decline costs on a review-mode space.
 *
 * 🔴 The free half is `FREE_REVIEW_CAVEAT` itself rather than a paraphrase of it.
 * There are three statements of this rule in the product — this one, the caveat
 * under the draft's own free option, and `declineConsequence`'s free branch on the
 * owner's side — and two of the three now come from one constant, so a change to
 * what a decline costs cannot leave a stale copy behind in the tray.
 *
 * The paid half is kept in both branches: where both offers are open, somebody
 * choosing to pay still needs the fee disclosure.
 */
export const trayReviewLine = (freeAvailable: boolean) =>
  freeAvailable
    ? ` ${FREE_REVIEW_CAVEAT} A paid placement leaves part of what you paid with them.`
    : ' If they decline, part of what you paid stays with them.';
