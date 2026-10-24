import { bustMinorQueueCounts } from './minor-hash.service';
import type { checkedResolutionReason } from './resolution-reason';
import { callModEndpoint, type ActionResult, type JsonResult } from './user-actions.service';

/**
 * The write half of the minor-flag queues. Every verdict goes to the main app's
 * `/api/mod/minor-flag/*` rather than being re-implemented here.
 *
 * That is not caution about SQL. `revert` runs `setModelMinor`, which owns the search-index sync, the
 * cache busting and the per-image `minor` propagation, and then restores five columns from the flag
 * snapshot — including re-marking the images that were legitimately minor before the flag.
 * `resolveAppeal` additionally closes the `Appeal` row, and refuses to uphold against a model another
 * moderator has since reverted. A spoke-side copy of any of that would be a second implementation of a
 * minor-safety decision, drifting silently from the one the rest of the site reads.
 */

export const setModelMinorFlag = (modelId: number): Promise<ActionResult> =>
  toResult(callModEndpoint('minor-flag/set-minor', { modelId }, 'Set as minor'));

export const confirmMinorFlag = (modelId: number): Promise<ActionResult> =>
  toResult(callModEndpoint('minor-flag/confirm', { modelId }, 'Confirm flag'));

export const dismissMinorHashMatch = (modelId: number): Promise<ActionResult> =>
  toResult(callModEndpoint('minor-flag/dismiss', { modelId }, 'Dismiss match'));

/** The real-person half: set-poi applies the flag with every restriction it carries (and takes the
 *  model off the match queue); the hash flag's own endpoints sign it off, roll it back and drop a lead.
 *  Those three answer 200 with a 0 count when there was nothing to act on, which is reported as a
 *  failure rather than as done. */
export const setModelPoiFlag = (modelId: number): Promise<ActionResult> =>
  toResult(callModEndpoint('model/set-poi', { modelId, poi: true }, 'Flag as real person'));

export const confirmPoiFlag = (modelId: number): Promise<ActionResult> =>
  toCountedResult(
    callModEndpoint('poi-flag/confirm', { modelId }, 'Confirm flag'),
    'confirmed',
    'Nothing was confirmed: this model carries no hash-applied real-person flag. Reload the queue.'
  );

export const revertPoiFlag = (modelId: number): Promise<ActionResult> =>
  toCountedResult(
    callModEndpoint('poi-flag/revert', { modelId }, 'Revert flag'),
    'reverted',
    'Nothing was reverted: this model carries no hash-applied real-person flag. Check the model before retrying.'
  );

export const dismissPoiHashMatch = (modelId: number): Promise<ActionResult> =>
  toCountedResult(
    callModEndpoint('poi-flag/dismiss', { modelId }, 'Dismiss match'),
    'dismissed',
    'Nothing was dismissed: this model is no longer waiting on a real-person match. Reload the queue.'
  );

export type RulingReason = Exclude<ReturnType<typeof checkedResolutionReason>, string>;

/** `rescanQueued` is always false now: the endpoint keeps it for compatibility. */
export type AppealResult = { ok: true; rescanQueued: boolean } | { ok: false; error: string };

export const resolveMinorFlagAppeal = (
  modelId: number,
  uphold: boolean,
  reason: RulingReason
): Promise<AppealResult> =>
  toAppealResult(
    callModEndpoint(
      'minor-flag/resolve-appeal',
      { modelId, uphold, ...reason },
      uphold ? 'Uphold flag' : 'Overturn flag'
    )
  );

export const resolveMinorFlagAppealPerLabel = (
  modelId: number,
  labels: { minor: 'uphold' | 'overturn'; poi: 'uphold' | 'overturn' },
  reason: RulingReason
): Promise<AppealResult> =>
  toAppealResult(
    callModEndpoint(
      'minor-flag/resolve-appeal',
      { modelId, uphold: false, ...labels, ...reason },
      'Rule per label'
    )
  );

export type RedetectionOutcome = 'kept' | 'dismissed' | 'closed';
export type RedetectionResult =
  | { ok: true; resolved: RedetectionOutcome }
  | { ok: false; error: string };

/** Rules on a label the text scan re-detected after a human had cleared it, for the text the
 *  moderator was shown (`textHash`). The main app owns the write: keeping applies the flag with every
 *  restriction and the owner notice a scan would have. `closed` means the model was already flagged. */
export async function resolveRedetection(
  modelId: number,
  label: 'minor' | 'poi',
  keep: boolean,
  textHash: string,
  reason: RulingReason
): Promise<RedetectionResult> {
  const result = await callModEndpoint(
    'minor-flag/resolve-redetection',
    { modelId, label, keep, textHash, ...reason },
    keep ? 'Keep re-detected flag' : 'Dismiss re-detection'
  );
  if (!result.ok) return result;
  await bustMinorQueueCounts();
  const resolved = result.body.resolved;
  return {
    ok: true,
    resolved: resolved === 'closed' || resolved === 'dismissed' ? resolved : 'kept',
  };
}

export type FlagRulingResult =
  | { ok: true; ruled: 'kept' | 'lifted'; label: 'minor' | 'poi'; modelId: number }
  | { ok: false; error: string };

/** Rules on a standing text-scan flag outside an appeal, for the text the moderator was shown
 *  (`textHash`); the main app refuses when that text has changed or an owner appeal is open on a keep. */
export async function ruleTextScanFlag({
  modelId,
  label,
  keep,
  textHash,
  reason,
}: {
  modelId: number;
  label: 'minor' | 'poi';
  keep: boolean;
  textHash: string;
  reason: RulingReason;
}): Promise<FlagRulingResult> {
  const result = await callModEndpoint(
    'minor-flag/rule',
    { modelId, label, keep, textHash, ...reason },
    keep ? 'Keep flag' : 'Lift flag'
  );
  if (!result.ok) return result;
  await bustMinorQueueCounts();
  return { ok: true, ruled: result.body.ruled === 'lifted' ? 'lifted' : 'kept', label, modelId };
}

/**
 * Revert is the one action whose 200 does not mean it happened. A model whose snapshot capture failed
 * — capture is best-effort — has nothing to restore, so the endpoint answers `reverted: 0` and the
 * flag is still on. Reporting that as success is how a moderator comes away believing they cleared a
 * model they did not.
 */
export async function revertMinorFlag(modelId: number): Promise<ActionResult> {
  const result = await callModEndpoint('minor-flag/revert', { modelId }, 'Revert flag');
  if (!result.ok) return result;

  const reverted = Number(result.body.reverted ?? 0);
  if (reverted > 0) {
    await bustMinorQueueCounts();
    return { ok: true };
  }
  return {
    ok: false,
    error:
      Number(result.body.failed ?? 0) > 0
        ? 'The revert failed partway — the flag may still be applied. Check the model before retrying.'
        : 'Nothing was reverted: this model has no flag snapshot to restore, so its pre-flag state is unknown. Clear it by hand.',
  };
}

const toAppealResult = async (call: Promise<JsonResult>): Promise<AppealResult> => {
  const result = await call;
  if (!result.ok) return result;
  await bustMinorQueueCounts();
  return { ok: true, rescanQueued: result.body.rescanQueued === true };
};

const toResult = async (call: Promise<JsonResult>): Promise<ActionResult> => {
  const result = await call;
  if (!result.ok) return result;
  await bustMinorQueueCounts();
  return { ok: true };
};

const toCountedResult = async (
  call: Promise<JsonResult>,
  key: string,
  none: string
): Promise<ActionResult> => {
  const result = await call;
  if (!result.ok) return result;
  if (!(Number(result.body[key] ?? 0) > 0)) return { ok: false, error: none };
  await bustMinorQueueCounts();
  return { ok: true };
};
