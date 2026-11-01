/**
 * What a finished purge tells the operator, read from the main app's `/api/mod/remove-all-content`
 * answer. Import-free: the main app's suite loads it by path and feeds it the endpoint's real body.
 */

// Not "re-run the purge": a re-run finds the account's content already gone, so steps keyed on it
// (search index, bid refunds) have nothing left to retry. The logs name what each one needs.
export const PURGE_INCOMPLETE =
  'Purge finished, but some cleanup steps failed and were logged. Purging again will not retry all of them.';

export function purgeWarning(body: unknown): string | undefined {
  const incomplete = (body as { incomplete?: unknown } | null)?.incomplete;
  return Array.isArray(incomplete) && incomplete.length ? PURGE_INCOMPLETE : undefined;
}
