import { callRetoolEndpoint, type ActionResult } from './user-actions.service';

/**
 * The write half of the minor-flag queues. Every verdict goes to the main app's
 * `/api/mod/retool/minor-flag` rather than being re-implemented here.
 *
 * That is not caution about SQL. `revert` runs `setModelMinor`, which owns the search-index sync, the
 * cache busting and the per-image `minor` propagation, and then restores five columns from the flag
 * snapshot — including re-marking the images that were legitimately minor before the flag.
 * `resolveAppeal` additionally closes the `Appeal` row, and refuses to uphold against a model another
 * moderator has since reverted. A spoke-side copy of any of that would be a second implementation of a
 * minor-safety decision, drifting silently from the one the rest of the site reads.
 */

export const setModelMinorFlag = (modelId: number): Promise<ActionResult> =>
  toResult(callRetoolEndpoint('minor-flag', { action: 'setMinor', modelId }, 'Set as minor'));

export const confirmMinorFlag = (modelId: number): Promise<ActionResult> =>
  toResult(callRetoolEndpoint('minor-flag', { action: 'confirm', modelId }, 'Confirm flag'));

export const dismissMinorHashMatch = (modelId: number): Promise<ActionResult> =>
  toResult(callRetoolEndpoint('minor-flag', { action: 'dismiss', modelId }, 'Dismiss match'));

export const resolveMinorFlagAppeal = (modelId: number, uphold: boolean): Promise<ActionResult> =>
  toResult(
    callRetoolEndpoint(
      'minor-flag',
      { action: 'resolveAppeal', modelId, uphold },
      uphold ? 'Uphold flag' : 'Overturn flag'
    )
  );

/**
 * Revert is the one action whose 200 does not mean it happened. A model whose snapshot capture failed
 * — capture is best-effort — has nothing to restore, so the endpoint answers `reverted: 0` and the
 * flag is still on. Reporting that as success is how a moderator comes away believing they cleared a
 * model they did not.
 */
export async function revertMinorFlag(modelId: number): Promise<ActionResult> {
  const result = await callRetoolEndpoint('minor-flag', { action: 'revert', modelId }, 'Revert flag');
  if (!result.ok) return result;

  const reverted = Number(result.body.reverted ?? 0);
  if (reverted > 0) return { ok: true };
  return {
    ok: false,
    error:
      Number(result.body.failed ?? 0) > 0
        ? 'The revert failed partway — the flag may still be applied. Check the model before retrying.'
        : 'Nothing was reverted: this model has no flag snapshot to restore, so its pre-flag state is unknown. Clear it by hand.',
  };
}

const toResult = async (call: ReturnType<typeof callRetoolEndpoint>): Promise<ActionResult> => {
  const result = await call;
  return result.ok ? { ok: true } : result;
};
