/**
 * The advisory-lock class (`pg_advisory_xact_lock(ITEM_HOLDER_LOCK_CLASS, userId)`) taken by shop
 * purchases, mystery box opens, and the moderator app's cosmetic grants and refunds. Not by every
 * grant: event rewards, milestones and other main-app grants do not take it. The main app and the
 * moderator app deploy separately, so the number must never change.
 */
export const ITEM_HOLDER_LOCK_CLASS = 0x49480001;
