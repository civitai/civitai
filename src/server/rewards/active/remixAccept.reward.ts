import { createBuzzEvent } from '../base.reward';

const ACCEPT_AWARD = 20;

// Daily ceiling across every gallery the owner runs, not a per-submission cap.
// The on-demand Lua cap counts all entries in the per-(user, type) daily hash, so
// this is a total: 20 Buzz for each of the first 5 accepts per UTC day.
//   ⚠️ At `cap === ACCEPT_AWARD` the first accept of the day would exhaust it and
//   every later one would award 0, which is not the reward that was designed.
const DAILY_ACCEPT_CEILING = ACCEPT_AWARD * 5;

/**
 * Blue-buzz reward paid to a creator for accepting a remix submission.
 *
 * Paid for **every** accepted submission, free or paid: this rewards running the
 * surface at all, and is not compensation for a placement having been free.
 *
 * ONCE EVER PER PLACEMENT, and the guarantee is not this cap. `settlePlacement`
 * claims its transition with `WHERE status = 'pending'`, so exactly one call in a
 * placement's life returns `settled: true`, and the caller fires this only on
 * that one. Nothing moves an approved row back to pending, so there is no second
 * winning approve to fire on.
 *
 * That gate is load-bearing rather than belt-and-braces, because the two dedups
 * underneath it expire on different clocks. The Buzz ledger keys this on the
 * placement — `remixAccept:<placementId>-<ownerId>-<placerId>` — and that key
 * never expires, while the on-demand dedup and the cap live in a Redis hash that
 * expires at the end of the UTC day. So re-presenting an already-rewarded
 * placement on a later day passes the dedup, **spends a slot of the owner's
 * daily cap**, and is then refused by the ledger as a duplicate: the owner loses
 * one of their five accepts for the day and no Buzz moves, silently. Any future
 * caller that can hand this a placement it already paid for has to establish the
 * same once-ever property before calling.
 *
 * The cap multiplies with membership tier, as every reward here does — a gold
 * member's 100/day is 400/day. Known and accepted.
 */
export const remixAcceptReward = createBuzzEvent({
  type: 'remixAccept',
  toAccountType: 'blue',
  description: 'You accepted a remix into your gallery',
  triggerDescription: 'For each of the first 5 remix submissions you accept each day',
  awardAmount: ACCEPT_AWARD,
  cap: DAILY_ACCEPT_CEILING,
  onDemand: true,
  getKey: async (input: RemixAcceptEvent) => ({
    // The owner earns it; the submitter is recorded as the cause, not paid.
    toUserId: input.ownerId,
    // The Redis dedup anchor as well as the ledger's: distinct placements hash to
    // distinct cache keys and each pays, while the same placement re-presented
    // within the day is deduped.
    forId: input.placementId,
    byUserId: input.placerId,
  }),
});

type RemixAcceptEvent = {
  placementId: number;
  ownerId: number;
  placerId: number;
};
