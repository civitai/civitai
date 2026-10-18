/**
 * The advisory-lock class (`pg_advisory_xact_lock(ITEM_HOLDER_LOCK_CLASS, userId)`) shared by the main
 * app and the moderator app, which deploy separately: the number must never change. Not every grant
 * path takes it.
 */
export const ITEM_HOLDER_LOCK_CLASS = 0x49480001;

/**
 * How long `lockItemHolder` waits before Postgres cancels with `55P03`. Set for the rest of the
 * transaction, so it also bounds every later lock wait in it.
 */
export const ITEM_HOLDER_LOCK_TIMEOUT = '2s';
