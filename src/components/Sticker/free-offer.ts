import { FREE_SLOT_TAKEN_NOTE } from '~/shared/utils/placement';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * Whether the free offer is on the table, and what it says.
 *
 * One import, and it is a constants module — for the same reason `payout-copy.ts`
 * has none: these are the branches most worth testing and the least worth
 * dragging Mantine, tRPC and the edge image loader into a unit run to reach.
 * `~/shared/utils/placement` pulls in none of that. It is the rules themselves,
 * and the clauses that describe them live beside them there, so the remix
 * gallery does not have to import a sticker module for a fact neither surface
 * owns.
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
 * The free option's own label.
 *
 * 🔴 **Deliberately does NOT carry the mode any more.** It read `Free · needs
 * review` beside a plain `100 Buzz`, which says the paid one does not — and on
 * this surface both go to the creator for review, always. Justin's words on
 * seeing it: "it makes it seem like the other one's not going to need review".
 *
 * The mode is still said, once, under the button that spends the placement,
 * where it applies to whichever option is selected rather than to one of them.
 */
export const freeOptionLabel = () => 'Free';

/**
 * The one line under the button that spends the placement.
 *
 * Shrunk to the only fact that has to land: pressing this spends your free
 * placement, and a decline does not give it back. It used to be two sentences
 * explaining the asymmetry between the creator's slot and the placer's day —
 * true, but nobody standing over a Place button is reading a paragraph about
 * accounting.
 *
 * Under the button rather than above it, with an alert triangle, so it reads as
 * a consequence of pressing rather than as a description of the option.
 */
export const FREE_REVIEW_CAVEAT = 'Spends your free placement, even if they decline it';

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
/**
 * The spent-allowance sentence, which three surfaces say.
 *
 * The bar said "Yours is back", the refusal ladder said "It comes back", and
 * both name the shared budget — two wordings of the one fact this change exists
 * to stop drifting. One function, so a reword lands everywhere or nowhere.
 */
export const spentAllowanceNote = () => "You have used today's free placement.";

export function freeRefusalMessage(standing?: FreeStanding, space?: FreeCapacity) {
  // Permanent for this image, and true of everybody — so it outranks the two
  // below it, which are about this placer and about right now.
  if (space && space.freeSlots <= 0)
    return 'This creator is not taking free stickers on this image.';
  // Permanent for this placer on this image: once ever, not once per day.
  if (standing?.usedHere) return 'You have already used a free sticker on this image.';
  // Transient, and it says when it lifts — derived from the reset the server
  // computed rather than restating the boundary here.
  if (standing && standing.remaining <= 0) return spentAllowanceNote();
  // The most transient of all — a declined placement releases its slot at once.
  //
  // ⚠️ Two readers, two truths, so the wording is chosen by the caller. Someone
  // who pressed and lost the race is told they lost it; someone still deciding
  // has pressed nothing, and "first" would be false. `preCommitFreeReason`
  // substitutes `FREE_SLOT_TAKEN_NOTE` for exactly this rung.
  if (space && space.freeSlotsRemaining <= 0)
    return 'Someone took the last free slot on this image first.';
  return null;
}

/**
 * The reason free is unavailable, said while the choice is still being made — or
 * `null` when there is nothing worth saying.
 *
 * 🔴 **The reason existed and was only ever shown AFTER the server refused.**
 * `freeRefusalMessage` had exactly one consumer, the post-refusal handler, so
 * somebody who had spent their day or already free-placed here saw a plain paid
 * button, pressed it, and paid. The remix modal has rendered its reason inline
 * since it shipped; this is that pattern for the surface that lacked it.
 *
 * Two guards, and each one is a state where the sentence would be worse than
 * silence:
 *
 * - **`freeAvailable`** — free is on the table, so there is no refusal to
 *   explain. Without this the ladder's last rung would narrate a slot count at
 *   somebody about to take one.
 * - **`freeSlots <= 0`** — this creator takes no free placements at all, which
 *   is the first rung and true of every ordinary paid image. Nobody is waiting
 *   on an offer that was never made, so it would be noise on most of the site.
 *
 * Both inputs must have arrived. Asserted from defaulted zeroes this tells a
 * fresh reader their allowance is spent for as long as the query takes.
 *
 * Separate from `freeRefusalMessage` rather than folded into it, because that
 * one answers a refusal that already happened and may not be about the free tier
 * at all — its `null` return is load-bearing there in a way it is not here.
 */
export function preCommitFreeReason(
  freeAvailable: boolean,
  standing?: FreeStanding,
  space?: FreeCapacity
) {
  if (freeAvailable) return null;
  if (!space || !standing) return null;
  if (space.freeSlots <= 0) return null;

  // 🔴 The one rung whose wording depends on who is reading it. The ladder's
  // version — "someone took the last free slot FIRST" — was written for a
  // placer who pressed and lost a race. Said before the press it is false about
  // the reader and contradicts what the bar's own tooltip says for the same
  // state, so both take the shared clause instead.
  if (!standing.usedHere && standing.remaining > 0 && space.freeSlotsRemaining <= 0)
    return FREE_SLOT_TAKEN_NOTE;

  return freeRefusalMessage(standing, space);
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
 * The free label on the reaction bar, or `null` for no label at all.
 *
 * 🔴 **This is the fix for the whole ticket.** The bar used to print the
 * creator's `N of M free` capacity, which is a fact about the IMAGE, in a place
 * every reader takes as an offer to THEM — so a viewer who had spent their day
 * saw "1 of 1 free" on every image, pressed it, and was charged. Justin hit it
 * live in a meeting; a user hit it ninety minutes after launch.
 *
 * All three rules have to hold before the word "free" is allowed on screen: the
 * creator must have an open slot, the viewer must still have their placement for
 * today, and they must not already have free-placed on this image. The number is
 * the smaller of the two counts, because that is how many the reader can take.
 *
 * ⚠️ **`standing` is `undefined` while the query is in flight, and that is not
 * "no allowance".** Rendering the paid state on `undefined` would flash the
 * price and then add a free label a beat later; the label is simply absent until
 * the answer lands, which is what an image with no free capacity also shows.
 */
export function barFreeLabel(space?: FreeCapacity, standing?: FreeStanding) {
  if (!space || !standing) return null;
  if (space.freeSlots <= 0 || space.freeSlotsRemaining <= 0) return null;
  if (standing.remaining <= 0 || standing.usedHere) return null;

  return `${Math.min(space.freeSlotsRemaining, standing.remaining)} free`;
}

/**
 * The line on the free hint, or `null` when there is no hint to show.
 *
 * 🔴 **Replaces the bar's tooltip, and the difference is who gets to see it.** A
 * tooltip is hover-only, so on a phone the whole free tier was invisible until
 * you opened the tray — the state that matters most, "you have one and it is
 * free", was told only to people with a mouse. A popover is on screen for
 * everyone and dismissable by anyone.
 *
 * Said only where free is genuinely on offer. The states where it is not —
 * spent, held, already used here, no capacity — get nothing at the bar at all
 * and are explained in the tray, at the point the choice is actually made. A
 * notice that pops up to tell you what you CANNOT have is an interruption
 * charging rent on somebody else's image.
 */
export function freeHintText(space?: FreeCapacity, standing?: FreeStanding) {
  const label = barFreeLabel(space, standing);
  if (!label) return null;

  const count = Math.min(space?.freeSlotsRemaining ?? 0, standing?.remaining ?? 0);

  // A label, not a sentence. It sits on a chip beside a button, where "You have
  // a free sticker today" is three words of throat-clearing before the noun.
  return count === 1 ? 'Daily free sticker' : `${count} daily free stickers`;
}

/**
 * What the tray says, as separate short lines rather than one sentence.
 *
 * 🔴 **The prose version was unreadable.** It ran the full width of the panel —
 * price, then review, then what a decline costs, then why free was unavailable,
 * concatenated with ` · ` separators — and at that width nobody reads to the
 * end. Justin, looking at it: "the text is just way too long there… completely
 * unreadable."
 *
 * Lines also fix a defect the concatenation kept producing: each fragment had to
 * know whether another would be appended after it, so a full stop added to one
 * of them rendered a separator mid-sentence. A list has no such coupling.
 *
 * Ordered by what changes a decision: what it costs, what happens to it, what
 * pressing spends, and last the reason free is off the table — which is the only
 * one that is about the reader rather than the placement.
 *
 * `tone` picks the icon at the render site rather than naming one here, so this
 * module stays free of anything that has to be mounted to be tested.
 */
export type TrayNote = { id: string; tone: 'info' | 'warn'; text: string };

export function trayNotes({
  freeAvailable,
  price,
  review,
  reason,
  declineFee,
}: {
  freeAvailable: boolean;
  price: number;
  /**
   * What the creator keeps if they decline, in Buzz. Absent while the space is
   * still loading, which is why the vaguer sentence survives as a fallback
   * rather than being deleted — a number that is not known yet must not render
   * as "they keep 0 Buzz".
   */
  declineFee?: number;
  /** The space reviews placements, so nothing goes live until the owner says so. */
  review: boolean;
  /** From `preCommitFreeReason` — `null` whenever free is genuinely on offer. */
  reason?: string | null;
}): TrayNote[] {
  const notes: TrayNote[] = [
    {
      id: 'price',
      tone: 'info',
      // The price of the NEXT placement, not a menu. The free one is taken
      // automatically by the first draft that can use it, so naming both prices
      // read as a choice the placer does not get to make.
      text: freeAvailable ? 'Free placement + one sticker use' : `${price} Buzz + one sticker use`,
    },
  ];

  if (review)
    notes.push({
      id: 'review',
      tone: 'info',
      text: 'Only you see it until the creator approves',
    });

  // What pressing costs, which differs by what is being pressed: a free
  // placement spends the day regardless, a paid one leaves part of the money.
  if (review)
    notes.push({
      id: 'decline',
      tone: 'warn',
      text: freeAvailable
        ? FREE_REVIEW_CAVEAT
        : declineFee
        ? // The exact number, because "part of what you paid" is the one thing a
          // placer cannot check for themselves and the amount is what actually
          // leaves their wallet. It comes from the server already computed: the
          // rate is operator-tunable and floors at 1⚡, so a percentage worked
          // out here would be wrong on precisely the cheap placements the floor
          // exists for.
          `If they decline, they keep ${numberWithCommas(declineFee)} Buzz`
        : 'If they decline, part of what you paid stays with them',
    });

  if (reason) notes.push({ id: 'reason', tone: 'warn', text: reason });

  return notes;
}
