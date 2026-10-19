import { callModEndpoint } from './user-actions.service';

export {
  countPendingCsamHolds,
  listPendingCsamHolds,
  type CsamHoldRow,
} from './csam-holds.queries';

export type CsamHoldDecisionResult = { ok: true } | { ok: false; error: string };

/** Mirrors the main app's `CSAM_HOLD_DECISIONS`; the page's zod enum is checked against this at compile time. */
export type CsamHoldDecision =
  | 'dismiss'
  | 'remove'
  | 'remove_strike'
  | 'remove_ban'
  | 'remove_ban_report';

const MAY_HAVE_COMPLETED =
  'Could not confirm the decision. It may already have completed — reload the queue before retrying.';

/** The main app applies the decision (removal, strike, ban) and records it with the hold in one step. */
export async function decideCsamHold({
  holdId,
  decision,
  note,
}: {
  holdId: number;
  decision: CsamHoldDecision;
  note?: string;
}): Promise<CsamHoldDecisionResult> {
  const result = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holdId, decision, ...(note ? { note } : {}) },
    'Decide hold'
  );
  if (!result.ok) {
    // Nobody answered, yet the request left: the main app may have applied it.
    if (!result.requestNeverSent && result.status === undefined)
      return { ok: false, error: MAY_HAVE_COMPLETED };
    return { ok: false, error: result.error };
  }
  const expected = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
  if (result.body.status !== expected)
    return {
      ok: false,
      error: `The main app did not report the hold as ${expected.toLowerCase()}.`,
    };
  return { ok: true };
}
