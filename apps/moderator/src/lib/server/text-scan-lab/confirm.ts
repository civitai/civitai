import { CONFIRM_ABOVE } from '../../text-scan-lab/limits';

export type PlannedRun<R> = {
  count: number;
  skipped: number;
  stamp: string;
  execute: (userId: number) => Promise<R>;
};

export const confirmStamp = (count: number, version?: Date | null) =>
  `${count}:${version ? version.toISOString() : ''}`;

export type ConfirmRequest = {
  needsConfirm: true;
  count: number;
  skipped: number;
  stamp: string;
  seconds: number;
  changed: boolean;
};

/**
 * Null when the run may start: small enough to need no confirmation, or confirmed with this exact
 * stamp (the confirm button posts it as `confirmed`).
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
