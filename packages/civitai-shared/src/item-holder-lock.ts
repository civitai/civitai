/**
 * The advisory-lock class every path that grants to a user, or takes a grant back, locks under
 * (`pg_advisory_xact_lock(ITEM_HOLDER_LOCK_CLASS, userId)`). The main app and the moderator app
 * both take it and deploy separately, so the number must never change.
 */
export const ITEM_HOLDER_LOCK_CLASS = 0x49480001;
