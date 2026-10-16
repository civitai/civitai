import type { ModelUnpublishReason } from '$lib/model-unpublish-reasons';
import { revertMinorFlag, setModelMinorFlag } from './minor-flag.service';
import { callModEndpoint, type ActionResult, type JsonResult } from './user-actions.service';

/**
 * What a moderator can do to a reported model from the reports panel. Every write goes to the main
 * app's `/api/mod/model/*`, which wraps the same service the model page's moderator menu calls —
 * unpublishing writes the owner notification, taking down stamps who did it and when. None of that
 * is re-implemented here, so the two apps cannot act differently. There is deliberately no delete:
 * a report is answered by taking a model down, not by destroying the evidence it was about.
 *
 * These never touch the report. Acting on the model and closing the report are separate decisions —
 * one report can need two actions, and Actioned pays the reporters — so the panel keeps them apart.
 *
 * Every action but unpublish has its undo here, as it does on the model page: a misclick in a queue
 * worked row after row needs a way back that is not a second tab. Unpublish has none on purpose —
 * republishing a violation is an appeal decision, and it republishes every version at once.
 */

export type ModelReportAction =
  | 'unpublish'
  | 'setMinor'
  | 'unsetMinor'
  | 'setSfwOnly'
  | 'unsetSfwOnly'
  | 'setPoi'
  | 'unsetPoi'
  | 'takeDown'
  | 'bringBack';

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

export const bringBackReportedModel = (modelId: number): Promise<ActionResult> =>
  done(callModEndpoint('model/bring-back', { modelId }, 'Bring back'));

/** Both directions. Unsetting leaves the NSFW rating and gallery level as they are — the main app's
 *  service does that on purpose, since the model may have been SFW before it was ever flagged. */
export const setReportedModelSfwOnly = (modelId: number, sfwOnly: boolean): Promise<ActionResult> =>
  done(
    callModEndpoint(
      'model/set-sfw-only',
      { modelId, sfwOnly },
      sfwOnly ? 'Set as SFW' : 'Allow NSFW'
    )
  );

/** Both directions. Setting also makes the model SFW-only, as a POI model always is; lifting leaves
 *  that as it is, the way unflagging minor does. */
export const setReportedModelPoi = (modelId: number, poi: boolean): Promise<ActionResult> =>
  done(callModEndpoint('model/set-poi', { modelId, poi }, poi ? 'Flag as POI' : 'Unflag POI'));

export const setReportedModelMinor = (modelId: number): Promise<ActionResult> =>
  setModelMinorFlag(modelId);

/**
 * The minor queues' revert, not a bare `minor: false`. Setting minor snapshots the model's pre-flag
 * state; reverting restores it, including images that were legitimately minor before the flag. It
 * refuses honestly when there is no snapshot to restore (an owner-set flag, or a failed capture).
 */
export const unsetReportedModelMinor = (modelId: number): Promise<ActionResult> =>
  revertMinorFlag(modelId);
