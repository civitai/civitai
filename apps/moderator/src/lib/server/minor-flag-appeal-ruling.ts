import { appealVerdict } from '$lib/minor-flags/appeal-split';
import { checkedResolutionReason } from './resolution-reason';
import { resolveMinorFlagAppeal, resolveMinorFlagAppealPerLabel } from './minor-flag.service';

type Decision = 'uphold' | 'overturn';

/** `uphold` keeps every flag, `overturn` lifts every flag; per-label rules each flag on its own. */
export type FlagAppealDecision = Decision | { minor: Decision; poi: Decision };

export type FlagAppealRuling = { ok: true; rescanQueued: boolean } | { ok: false; error: string };

/**
 * Rules a model's open minor/real-person flag appeal. The reason is checked against the verdict the
 * decision amounts to (and, for a split, against the labels it lifts) before the main app is called.
 * Shared by the Appeals queue and the ticket page so both record the same thing.
 */
export async function ruleFlagAppeal(input: {
  modelId: number;
  decision: FlagAppealDecision;
  reason: { resolvedReason?: string; internalNotes?: string };
}): Promise<FlagAppealRuling> {
  const { modelId, decision } = input;
  if (!(modelId > 0)) return { ok: false, error: 'Missing model id.' };

  if (typeof decision === 'string') {
    const uphold = decision === 'uphold';
    const reason = checkedResolutionReason(
      'flagAppeal',
      uphold ? 'Rejected' : 'Approved',
      input.reason
    );
    if (typeof reason === 'string') return { ok: false, error: reason };
    const result = await resolveMinorFlagAppeal(modelId, uphold, reason);
    return result.ok
      ? { ok: true, rescanQueued: result.rescanQueued === true }
      : { ok: false, error: result.error };
  }

  const { verdict, lifted } = appealVerdict(decision);
  const reason = checkedResolutionReason(
    'flagAppeal',
    verdict,
    input.reason,
    lifted.length ? lifted : undefined
  );
  if (typeof reason === 'string') return { ok: false, error: reason };
  const result = await resolveMinorFlagAppealPerLabel(modelId, decision, reason);
  return result.ok
    ? { ok: true, rescanQueued: result.rescanQueued === true }
    : { ok: false, error: result.error };
}
