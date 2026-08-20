import { FREE_SLOT_TAKEN_NOTE, SHARED_ALLOWANCE_NOTE } from '~/shared/utils/placement';

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
/**
 * The spent-allowance sentence, which three surfaces say.
 *
 * The bar said "Yours is back", the refusal ladder said "It comes back", and
 * both name the shared budget — two wordings of the one fact this change exists
 * to stop drifting. One function, so a reword lands everywhere or nowhere.
 */
export const spentAllowanceNote = (resetsAt?: Date | string) =>
  `You have used today's free placement — ${SHARED_ALLOWANCE_NOTE}. It comes back ${allowanceResetLabel(
    resetsAt
  )}.`;

export function freeRefusalMessage(standing?: FreeStanding, space?: FreeCapacity) {
  // Permanent for this image, and true of everybody — so it outranks the two
  // below it, which are about this placer and about right now.
  if (space && space.freeSlots <= 0)
    return 'This creator is not taking free stickers on this image.';
  // Permanent for this placer on this image: once ever, not once per day.
  if (standing?.usedHere) return 'You have already used a free sticker on this image.';
  // Transient, and it says when it lifts — derived from the reset the server
  // computed rather than restating the boundary here.
  if (standing && standing.remaining <= 0) return spentAllowanceNote(standing.resetsAt);
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
 * The free label on the reaction bar, or `null` for no label at all.
 *
 * 🔴 **This is the fix for the whole ticket.** The bar used to print the
 * creator's `N of M free` capacity, which is a fact about the IMAGE, in a place
 * every reader takes as an offer to THEM — so a viewer who had spent their day
 * saw "1 of 1 free" on every image in the feed, pressed it, and was charged.
 * Justin hit it live in a meeting; a user hit it ninety minutes after launch.
 *
 * Both scarcities have to hold before the word "free" is allowed on screen: the
 * creator must have an open slot AND the viewer must still have their placement
 * for today. The number is the smaller of the two, because that is how many the
 * reader can actually use.
 *
 * ⚠️ **`allowanceRemaining` is `undefined` while the query is in flight, and
 * that is not zero.** Rendering the paid state on `undefined` would flash the
 * price and then add a free label a beat later on every card in the feed; the
 * label is simply absent until the answer lands, which is the same thing an
 * image with no free capacity shows.
 *
 * The one rule the bar cannot see is "already used a free placement on THIS
 * image" — that needs a per-image query, which is exactly the per-card cost this
 * design avoids. The tray makes that check before anything is committed.
 */
export function barFreeLabel(
  space: FreeCapacity | undefined,
  allowanceRemaining: number | undefined
) {
  if (!space || allowanceRemaining == null) return null;
  if (space.freeSlots <= 0 || space.freeSlotsRemaining <= 0) return null;
  if (allowanceRemaining <= 0) return null;

  return `${Math.min(space.freeSlotsRemaining, allowanceRemaining)} free`;
}

/**
 * The bar's tooltip: the price always, and the reason free is off the table when
 * it is.
 *
 * The price stays in every branch. That was already the rule — the tooltip is
 * what stopped the old label being an outright lie about cost — and it survives
 * because the reason is the addition, not the replacement.
 *
 * Ordered like `freeRefusalMessage` and for the same reason: a refusal that is
 * permanent for this image outranks one that lifts by itself, so nobody is
 * promised a midnight reset that will not change what this creator offers.
 *
 * It is a separate ladder because it answers a different question — this one
 * from a bar that cannot see `usedHere`, that one from a surface that can — but
 * every SENTENCE the two share now comes from one place (`spentAllowanceNote`,
 * `FREE_SLOT_TAKEN_NOTE`). What differs is which rungs exist and in what order,
 * not how any of them is worded.

 * ⚠️ An ERRORED allowance query is `undefined` too, and renders exactly like a
 * loading one: the bare price, no free label anywhere on the page. Deliberate
 * and fail-closed — nobody is promised something they cannot have — but it does
 * mean a 401 makes the free tier invisible rather than noisy.
 */
export function barTooltip({
  price,
  space,
  allowanceRemaining,
  resetsAt,
}: {
  price: number;
  space?: FreeCapacity;
  allowanceRemaining?: number;
  resetsAt?: Date | string;
}) {
  const base = `Place a sticker · ${price} Buzz`;

  // Nothing free is on offer here for anyone, so there is nothing to explain.
  if (!space || space.freeSlots <= 0) return base;

  // Still loading. Say the price and claim nothing about the offer.
  if (allowanceRemaining == null) return base;

  if (allowanceRemaining <= 0) return `${base}. ${spentAllowanceNote(resetsAt)}`;

  if (space.freeSlotsRemaining <= 0) return `${base}. ${FREE_SLOT_TAKEN_NOTE}`;

  return `Place a sticker · free, or ${price} Buzz. Your free one is ${SHARED_ALLOWANCE_NOTE}.`;
}

/**
 * The tray's price line, which has to name both offers when both are open.
 *
 * The use is the constant: a free placement is free of the creator's price and of
 * nothing else. Saying so here is what stops the tray and the Place button
 * disagreeing about what a sticker costs.
 */
export const trayPriceLine = (freeAvailable: boolean, price: number) =>
  freeAvailable
    ? `Free, or ${price} Buzz · one use either way, and your free one is ${SHARED_ALLOWANCE_NOTE}`
    : `${price} Buzz + one use`;

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
