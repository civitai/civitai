/**
 * What the chip under the Place button says about where the Buzz goes.
 *
 * Its own module, with no imports, so it can be tested without pulling the
 * component's graph — Mantine, tRPC and the edge image loader — into the unit
 * suite for four string branches.
 *
 * Derived from the resolved share rather than compiled in: the shares are
 * operator-tunable at runtime, so a fixed sentence is a claim about money that
 * can stop being true with no deploy and nothing failing. Returns `null` while
 * the share is unknown — saying nothing is the only honest thing to say before
 * the number arrives.
 *
 * Split across two lines because a username has no length limit worth relying
 * on, and "All proceeds go to @some_extremely_long_name" on one line grows the
 * cluster sideways. The caller centres them and truncates the name.
 */
export function payoutCopy(
  ownerShare: number | undefined,
  ownerUsername: string | null | undefined
): { lead: string; name?: string } | null {
  if (ownerShare == null) return null;

  const lead =
    ownerShare >= 1 ? 'All proceeds go to' : `${Math.round(ownerShare * 100)}% of proceeds go to`;

  // "The creator" is ambiguous exactly where it is read: the placer is looking
  // at someone else's image wearing someone else's sticker, and both of those
  // have a creator. The unnamed wording stays as the fallback rather than a
  // blank, so a deleted account degrades to a whole sentence instead of a
  // dangling "go to".
  return ownerUsername ? { lead, name: `@${ownerUsername}` } : { lead: `${lead} the creator` };
}

/**
 * What the owner is told a decline costs, which is a different fact on a free
 * placement.
 *
 * The paid sentence — the placer keeps most of what they paid, a fee stays with
 * you — is the escrow's two-hold structure, and a free row has neither hold. So
 * on a free row it is not a rounding error in the wording, it is a false
 * statement about money made at the moment somebody decides.
 *
 * ⚠️ **`undefined` is a real case, not a missing value.** A bulk decline can hold
 * both kinds at once, where neither sentence is true of everything selected —
 * so that branch says only what covers both rather than picking the majority.
 */
export function declineConsequence(free: boolean | undefined) {
  if (free === true)
    return 'No Buzz moves — nothing was paid for this one. Their free placement for today is still spent.';
  if (free === false) return 'The placer keeps most of what they paid, and a fee stays with you.';
  return 'Any Buzz paid mostly returns to the placer with a fee staying with you; a free placement moves no Buzz.';
}

/**
 * The queue row's headline, which is the only money statement on the card the
 * Approve and Decline buttons sit under.
 *
 * Paid rows only. A free row carries `amount: 0`, enforced by the DB, so this
 * sentence would assert a payment of zero on the page the free-placement
 * notification sends the creator to — immediately above an irreversible choice.
 * The caller says nothing about money on a free row and badges it instead.
 */
export const placementPaymentSummary = (amount: number) => `paid ${amount} Buzz`;

/**
 * Which of those a queue row says, which is the branch that must not be lost.
 *
 * Here rather than as a ternary in the page: `src/pages` cannot carry a test —
 * Next treats every file under it as a route — so a `row.free ?` inline is a
 * money statement with nothing able to assert it. Dropping the free arm makes
 * the card read "paid 0 Buzz" over a free placement, on the page a "your
 * placement was free" notification links to, immediately above an irreversible
 * choice. Typecheck and every test still pass.
 *
 * The free arm names no amount at all — the badge beside it carries the fact.
 */
export const placementAmountLine = (free: boolean, amount: number) =>
  free ? 'placed this' : placementPaymentSummary(amount);

/**
 * What the placer's own row says about what it cost them.
 *
 * `null` on a free row, because there is no amount to name: `amount` is 0 by
 * DB constraint, so a number here reports a payment of zero rather than no
 * payment, and the badge beside it is what carries the fact. Same split as
 * `placementAmountLine` on the owner side, kept as its own function because the
 * two sentences are read by different people — the owner is told who paid them,
 * the placer is told what they spent.
 *
 * Here rather than as a ternary in the page: `src/pages` cannot carry a test, so
 * a money branch written inline there is one nothing can assert.
 */
export const placedSpendLabel = (free: boolean, amount: number) => (free ? null : `${amount} Buzz`);

/**
 * What a moderator take-down does to the money.
 *
 * Two axes, and free breaks the pending one specifically: a pending PAID row
 * settles as a forfeit of the whole escrow, and a pending free row has no escrow
 * to forfeit. Both statements are false on a free row in
 * `RemoveReportedPlacement`, where the live branch also promises the creator was
 * already paid.
 */
export function moderatorTakedownConsequence({
  pending,
  free,
}: {
  pending: boolean;
  free: boolean;
}) {
  if (free)
    return pending
      ? 'This one is still awaiting the owner. Nothing was paid for it, so no Buzz moves, and nobody is notified.'
      : 'The sticker comes off this content for everyone, recorded as a moderator takedown. Nothing was paid for it, so no Buzz moves, and nobody is notified.';

  return pending
    ? 'This one is still awaiting the owner. Taking it down forfeits everything the placer paid — they get nothing back, and nobody is notified.'
    : 'The sticker comes off this content for everyone, recorded as a moderator takedown. No Buzz moves and nobody is notified.';
}

/**
 * Whether a set of selected rows is all free, all paid, or mixed.
 *
 * Here rather than in the page because `declineConsequence` is what consumes it
 * and its `undefined` branch is already covered — inline in a page component the
 * collapse from "mixed" to "whichever kind we saw first" is a mutation nothing
 * can observe, and it makes a bulk decline assert a sentence false of half the
 * rows it is about.
 *
 * An id whose row is not paged in yet counts as unknown, which makes the whole
 * selection mixed. That is the safe direction: it says only what covers both.
 */
export function selectionFree(
  selected: number[],
  rows: { id: number; free: boolean }[]
): boolean | undefined {
  const kinds = new Set(selected.map((id) => rows.find((row) => row.id === id)?.free));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/**
 * Why a live sticker cannot be taken off yet.
 *
 * Mirrors the server's refusal in `removeApprovedSticker`, which is the thing
 * that actually decides. The week is the same either way — Justin's call — so
 * only the reason differs, and the paid reason is untrue on a free row.
 */
export const removalLockReason = (free: boolean) =>
  free
    ? 'Accepting a sticker is a commitment to keep it up for a week.'
    : 'Someone paid to place this, so it stays up for a week.';

/**
 * What a removal does to the money, once it is allowed.
 *
 * The paid line reassures the owner that the Buzz they were paid stays with
 * them. There is none on a free row, and inventing a reassurance about a payment
 * that never happened is how a support thread starts with somebody insisting
 * they were paid.
 */
export const removalConsequence = (free: boolean) =>
  free
    ? 'It comes off your image for everyone. No Buzz was paid for it, so none moves, and nobody is notified.'
    : 'It comes off your image for everyone. The Buzz you were paid for it stays with you, and nobody is notified.';

/**
 * The same chip, for the step before: buying the sticker itself.
 *
 * Named rather than "the creator" for the reason above, and more sharply here —
 * at this moment there are three parties in play (the image's owner, the
 * sticker's maker, and the site) and the buyer is about to pay two of them in
 * sequence. An official sticker has no maker to name, and "Civitai" is the true
 * answer there rather than a fallback.
 */
export function stickerPurchaseCopy(creatorUsername: string | null | undefined): {
  lead: string;
  name?: string;
} | null {
  // `undefined` is "not known here" and `null` is "there is no maker". The two
  // must not collapse: the owned-sticker payload carries no creator, and
  // defaulting it to the site would credit Civitai for a sticker somebody else
  // drew — a claim about money, made where the money is about to move.
  if (creatorUsername === undefined) return null;

  return creatorUsername
    ? { lead: 'This goes to', name: `@${creatorUsername}` }
    : { lead: 'This goes to Civitai' };
}
