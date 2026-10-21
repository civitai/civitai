/**
 * What a finished purge tells the operator, read from the main app's `/api/mod/remove-all-content`
 * answer. Import-free: the main app's suite loads it by path and feeds it the endpoint's real body.
 */

export const PURGE_INCOMPLETE = 'Purge finished; some cleanup steps failed and will need a re-run.';

/** The endpoint names the cleanup steps after the wipe that failed; the wipe itself is done. */
export function purgeWarning(body: unknown): string | undefined {
  const incomplete = (body as { incomplete?: unknown } | null)?.incomplete;
  return Array.isArray(incomplete) && incomplete.length ? PURGE_INCOMPLETE : undefined;
}
