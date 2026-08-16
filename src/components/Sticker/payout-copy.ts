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
} {
  return creatorUsername
    ? { lead: 'This goes to', name: `@${creatorUsername}` }
    : { lead: 'This goes to Civitai' };
}
