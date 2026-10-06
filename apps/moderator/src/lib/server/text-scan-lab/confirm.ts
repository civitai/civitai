import { CONFIRM_ABOVE } from '../../text-scan-lab/limits';

/** A run planned but not started: what it scans, what a confirmation must match, and how to start it. */
export type PlannedRun<R> = {
  count: number;
  /** Cases left out because their text was wiped. */
  skipped: number;
  stamp: string;
  execute: (userId: number) => Promise<R>;
};

/** Binds a confirmation to what was shown: the case count and, where one runs, the draft's version. */
export const confirmStamp = (count: number, version?: Date | null) =>
  `${count}:${version ? version.toISOString() : ''}`;

export type ConfirmRequest = {
  needsConfirm: true;
  count: number;
  skipped: number;
  stamp: string;
  seconds: number;
  /** The form confirmed an earlier request that no longer matches what would run. */
  changed: boolean;
};

/**
 * Null when the run may start: small enough to need no confirmation, or confirmed with this exact
 * stamp (the confirm button posts it as `confirmed`). Otherwise what to ask the moderator.
 */
export async function confirmRequest(
  form: FormData,
  run: Pick<PlannedRun<unknown>, 'count' | 'skipped' | 'stamp'>,
  estimateSeconds: () => Promise<number>
): Promise<ConfirmRequest | null> {
  if (run.count <= CONFIRM_ABOVE) return null;
  const confirmed = form.get('confirmed');
  if (confirmed === run.stamp) return null;
  return {
    needsConfirm: true,
    count: run.count,
    skipped: run.skipped,
    stamp: run.stamp,
    seconds: await estimateSeconds(),
    changed: typeof confirmed === 'string' && confirmed !== '',
  };
}
