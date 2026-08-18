/**
 * Shared by the resolver, the router and the moderator panel.
 *
 * A neutral module rather than `~/server/rewards/reward-config`, so a client
 * component reading these does not import the server module's db clients to get
 * at a string.
 */

// Live award amounts run 1..500 and caps 25..1500, so these leave room for a
// deliberate order-of-magnitude change while refusing the operator typo that
// adds a zero to the largest of them.
export const MAX_AWARD_AMOUNT = 5_000;
export const MAX_CAP = 100_000;

/**
 * The fields an override may set. The panel drives its inputs off this, so a
 * field added to the schema and not to the panel fails a test instead of being
 * silently deleted from the row by the next save.
 */
export const OVERRIDE_FIELDS = ['enabled', 'awardAmount', 'cap'] as const;

/**
 * 🔴 `setRewardConfig` refuses for two unrelated reasons under one CONFLICT code,
 * and the panel has to tell them apart to know whether reloading helps. Matching
 * on the prose made a copy edit silently route stale-hash conflicts to the
 * "unreadable" branch — which tells a moderator whose colleague merely saved
 * first that reloading is useless and to use the destructive overwrite.
 *
 * Comparing against these symbols means an edit here changes both sides at once,
 * and the tests import them too rather than restating the sentence in a regex.
 */
export const REWARD_CONFIG_CONFLICT = {
  stale:
    'The reward config changed since you loaded it. Reload to see the current values before saving.',
  unreadable:
    'The stored reward config cannot be read, so saving over it would discard values you were never shown. Fix the row, or save again with force.',
} as const;
