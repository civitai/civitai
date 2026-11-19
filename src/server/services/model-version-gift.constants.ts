export const GIFT_MINT_MAX_PER_CALL = 500;
export const GIFT_LIVE_CODES_MAX_PER_VERSION = 5000;
/** The most claims one multi-use link can take, and the cap given when a request names none. */
export const GIFT_LINK_MAX_REDEMPTIONS = 100;
export const GIFT_LINK_DEFAULT_REDEMPTIONS = 10;
export const GIFT_LIST_HISTORY = 200;
/** Rows per page of a creator's gift index, across all their versions. */
export const GIFT_INDEX_PAGE_MAX = 100;
/** Claimers per page of one gift link or batch. */
export const GIFT_CLAIMS_PAGE_MAX = 100;
/**
 * Claims before this moment are counted, never named: those claimers were not told the creator could
 * see them.
 */
export const GIFT_CLAIMER_NAMES_VISIBLE_SINCE = new Date('2026-11-09T12:00:00.000Z');
/** Returned with every recorded claim: the creator can list claimers. */
export const GIFT_CLAIM_NOTICE =
  'The creator can see that you claimed this, and can remove gifted access.';

// Advisory-lock classes: the first key of a two-key lock, so a gift lock never collides with another
// single-key lock on the same id.
/** Per model version: serialises mints under the live-code cap. */
export const GIFT_MINT_LOCK_CLASS = 0x47490001;
/** Per claimer: serialises new claims under the monthly allowance. */
export const GIFT_CLAIM_LOCK_CLASS = 0x47490002;
