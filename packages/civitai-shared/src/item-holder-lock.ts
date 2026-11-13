/**
 * The advisory-lock class (`pg_advisory_xact_lock(ITEM_HOLDER_LOCK_CLASS, userId)`) shared by the main
 * app and the moderator app, which deploy separately: the number must never change. Not every grant
 * path takes it.
 */
export const ITEM_HOLDER_LOCK_CLASS = 0x49480001;

export const ITEM_HOLDER_LOCK_TIMEOUT = '2s';
