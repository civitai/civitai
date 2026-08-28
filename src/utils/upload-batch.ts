/**
 * 🔴 ONE RULE FOR "SOME FILES IN THIS DROP FAILED", IN ONE PLACE.
 *
 * Two multi-file upload loops in the comics flow — `PanelModal`'s bulk panel drop and
 * `character.tsx`'s reference drop — are the same shape and, after this PR's hook change,
 * face the same new event: `uploadToCF` REJECTS on a refused PUT instead of resolving with
 * a dead key. They initially got two different remedies, which is how a predicate becomes
 * wrong at N−1 of its N sites. They now share this one:
 *
 *   1. CONTINUE. A refused PUT on file 2 of 10 must not silently abandon files 3–10. That
 *      is also the PRE-EXISTING behaviour of both loops — before the hook change a 403
 *      resolved and the loop carried on (with a dead key), so continuing restores what
 *      users had, minus the dead key.
 *   2. REPORT WHAT ACTUALLY HAPPENED. One notification, naming how many of how many
 *      failed and which files. A bare "Failed to upload image" over a ten-file drop tells
 *      the user neither that nine succeeded nor which one to retry.
 *
 * One aggregated notification rather than one per file, in both places: a bulk drop takes
 * up to 20 files and N toasts bury the UI they are reporting on.
 */
export type BatchUploadFailure = { name: string; error: Error };

/**
 * Arguments for `showErrorNotification` describing a partially-failed batch.
 *
 * Returns `null` when nothing failed, so a caller can write
 * `const report = batchUploadFailureNotification(...); if (report) showErrorNotification(report);`
 * without also open-coding the empty check — the case that produced a spurious
 * "0 of 5 failed" toast is then unreachable rather than merely avoided.
 */
export function batchUploadFailureNotification(
  failures: BatchUploadFailure[],
  total: number
): { title: string; error: { message: string }[] } | null {
  if (failures.length === 0) return null;

  // `showErrorNotification` renders an array of `{ message }` as a list, so each failed
  // file keeps its own name and its own reason rather than being collapsed into one line.
  return {
    title: `Failed to upload ${failures.length} of ${total} ${total === 1 ? 'file' : 'files'}`,
    error: failures.map(({ name, error }) => ({ message: `${name}: ${error.message}` })),
  };
}
