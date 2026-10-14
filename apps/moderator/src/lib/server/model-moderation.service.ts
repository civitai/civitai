import type { ModelUnpublishReason } from '$lib/model-unpublish-reasons';
import { setModelMinorFlag } from './minor-flag.service';
import { callModEndpoint, type ActionResult, type JsonResult } from './user-actions.service';

/**
 * What a moderator can do to a reported model from the reports panel. Every write goes to the main
 * app's `/api/mod/model/*`, which wraps the same service the model page's moderator menu calls —
 * unpublishing writes the owner notification, taking down stamps who did it and when. None of that
 * is re-implemented here, so the two apps cannot act differently. There is deliberately no delete:
 * a report is answered by taking a model down, not by destroying the evidence it was about.
 *
 * These never touch the report. The page action composes "act on the model, then set the report
 * Actioned", and only after the model call succeeded — see `+page.server.ts`.
 */

export type ModelReportAction = 'unpublish' | 'takeDown' | 'setSfwOnly' | 'setMinor';

const done = async (call: Promise<JsonResult>): Promise<ActionResult> => {
  const result = await call;
  return result.ok ? { ok: true } : result;
};

export async function unpublishReportedModel(input: {
  modelId: number;
  reason: ModelUnpublishReason;
  customMessage?: string;
  alsoFlagMinor: boolean;
}): Promise<ActionResult> {
  // BEFORE the unpublish, as the main app's `UnpublishModal` orders it: `setModelMinor` snapshots the
  // model's pre-flag state, and a failure here stops the unpublish. An unpublished model nobody
  // flagged is the outcome the flag exists to prevent.
  if (input.alsoFlagMinor) {
    const flagged = await setModelMinorFlag(input.modelId);
    if (!flagged.ok) return { ok: false, error: `Not unpublished — ${flagged.error}` };
  }
  return done(
    callModEndpoint(
      'model/unpublish',
      { modelId: input.modelId, reason: input.reason, customMessage: input.customMessage },
      'Unpublish'
    )
  );
}

export const takeDownReportedModel = (modelId: number): Promise<ActionResult> =>
  done(callModEndpoint('model/take-down', { modelId }, 'Take down'));

export const setReportedModelSfwOnly = (modelId: number): Promise<ActionResult> =>
  done(callModEndpoint('model/set-sfw-only', { modelId, sfwOnly: true }, 'Set as SFW'));

export const setReportedModelMinor = (modelId: number): Promise<ActionResult> =>
  setModelMinorFlag(modelId);
