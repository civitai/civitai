import { createBuzzEvent } from '../base.reward';

const ACCEPT_AWARD = 10;

/**
 * Ten a day, whatever the membership multiplier does to it. A daily cap can only
 * be satisfied by showing up daily, which is the behaviour being paid for; a
 * monthly one is filled in an afternoon and the account is then abandoned.
 */
const DAILY_ACCEPT_CEILING = ACCEPT_AWARD * 10;

/**
 * Blue Buzz to the owner of the space for accepting a sticker onto it.
 *
 * Paid on every accepted sticker, free or paid. It is not compensation for a
 * placement having been free — it pays for running the surface at all, which is
 * why the paid path earns it too.
 *
 * **Once per placement, ever, and the caller owns that.** The Buzz ledger keys
 * this on `stickerPlacementAccepted:<placementId>-<ownerId>-<placerId>` and that
 * key never expires, while the daily cap lives in a Redis hash that drops at the
 * end of each UTC day. So a placement re-presented on a later day passes the cap,
 * spends a tenth of the owner's day, and is then refused by the ledger as a
 * duplicate: no Buzz moves and nothing says so. `settlePlacement` is the only
 * caller and applies this only on the settle whose `WHERE status = 'pending'`
 * matched, so a second approve of the same placement never reaches here.
 */
export const stickerPlacementAcceptedReward = createBuzzEvent({
  type: 'stickerPlacementAccepted',
  toAccountType: 'blue',
  description: 'You accepted a sticker on your content',
  triggerDescription: 'For each sticker placement you accept, up to 10 a day',
  awardAmount: ACCEPT_AWARD,
  cap: DAILY_ACCEPT_CEILING,
  onDemand: true,
  getKey: async (input: StickerPlacementAcceptedEvent) => {
    // Both placement paths already refuse self-placement, so this is unreachable
    // today. It is here because the thing it prevents is minting Blue Buzz out of
    // nothing — accept your own sticker, collect — and the refusals that stop it
    // are two layers away and are about a product rule, not about this reward.
    if (input.ownerId === input.placerId) return false;

    return {
      toUserId: input.ownerId,
      forId: input.placementId,
      byUserId: input.placerId,
      type: `stickerPlacementAccepted`,
    };
  },
});

type StickerPlacementAcceptedEvent = {
  placementId: number;
  ownerId: number;
  placerId: number;
};
