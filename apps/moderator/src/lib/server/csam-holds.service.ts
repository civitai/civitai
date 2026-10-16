import { callModEndpoint } from './user-actions.service';

export {
  countPendingCsamHolds,
  listPendingCsamHolds,
  type CsamHoldRow,
} from './csam-holds.queries';

export type CsamHoldDecisionResult = { ok: true } | { ok: false; error: string };

const DISMISS_MAY_HAVE_COMPLETED =
  'Could not confirm the dismissal. It may already have completed — reload the queue before retrying.';

/** The main app owns the write and refuses a hold that is no longer pending. */
export async function dismissCsamHold({
  holdId,
  note,
}: {
  holdId: number;
  note?: string;
}): Promise<CsamHoldDecisionResult> {
  const result = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holdId, decision: 'dismiss', ...(note ? { note } : {}) },
    'Dismiss hold'
  );
  if (!result.ok) {
    // Nobody answered, yet the request left: the main app may have dismissed it.
    if (!result.requestNeverSent && result.status === undefined)
      return { ok: false, error: DISMISS_MAY_HAVE_COMPLETED };
    return { ok: false, error: result.error };
  }
  if (result.body.status !== 'Dismissed')
    return { ok: false, error: 'The main app did not report the hold as dismissed.' };
  return { ok: true };
}
