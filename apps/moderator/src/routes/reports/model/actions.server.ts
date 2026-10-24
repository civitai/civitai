import { fail, type RequestEvent } from '@sveltejs/kit';
import { getReportedModelId } from '$lib/server/reports.service';
import {
  bringBackReportedModel,
  setReportedModelMinor,
  setReportedModelPoi,
  setReportedModelSfwOnly,
  takeDownReportedModel,
  unpublishReportedModel,
  unsetReportedModelMinor,
} from '$lib/server/model-moderation.service';
import { isModelUnpublishReason, MINOR_UNPUBLISH_REASONS } from '$lib/model-unpublish-reasons';
import { denied } from '$lib/permissions';
import { canAccess } from '$lib/server/access';
import { reportStatusActions } from '$lib/server/report-queue-actions';
import { ReportEntity, reportPath } from '$lib/reports';

// The model queue's forms, taken by both pages that render a report — the bare queue and `[modelId]`.
// The report's own status and notes are shared with the table queues.
export const modelQueueActions = {
  // Every status, Pending and Processing included, unlike the user queue: whether Processing still
  // means "an ownership claim under investigation" is not settled, and until it is the model queue
  // keeps setting it. `rulingsOnly: true` is the switch once it is.
  ...reportStatusActions(),

  /**
   * Acts on the reported model through the main app — the model page's moderator menu without the
   * second tab. It does NOT touch the report: closing it is the panel's Report status buttons, a
   * separate decision. Doing both in one click took the report out of the queue before its result
   * could be seen, made a second action on the same model impossible from the panel, and paid the
   * reporters (Actioned does) as a side effect of a model button.
   *
   * The model is read from the REPORT, never the form or the path — a stale tab must not act on one
   * model while a moderator believes they are looking at another.
   */
  moderateModel: async ({ request, locals }: RequestEvent) => {
    if (!canAccess(locals.user, reportPath(ReportEntity.Model)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });

    const modelId = await getReportedModelId(id);
    if (modelId == null) return fail(410, { error: 'That report no longer exists.', gone: true });

    const action = String(data.get('modelAction'));
    let result;
    let done: string;
    switch (action) {
      case 'unpublish': {
        const reason = String(data.get('reason') ?? '');
        if (!isModelUnpublishReason(reason)) return fail(400, { error: 'Pick a reason.' });
        const customMessage = String(data.get('customMessage') ?? '').trim() || undefined;
        if (reason === 'other' && !customMessage)
          return fail(400, { error: 'A message to the owner is required for "Other".' });
        const alsoFlagMinor =
          MINOR_UNPUBLISH_REASONS.has(reason) && data.get('alsoFlagMinor') === 'on';
        result = await unpublishReportedModel({ modelId, reason, customMessage, alsoFlagMinor });
        done = alsoFlagMinor ? 'Flagged as minor and unpublished' : 'Unpublished';
        break;
      }
      case 'setMinor':
        result = await setReportedModelMinor(modelId);
        done = 'Flagged as minor';
        break;
      case 'unsetMinor':
        result = await unsetReportedModelMinor(modelId);
        done = 'Unflagged as minor';
        break;
      case 'setSfwOnly':
        result = await setReportedModelSfwOnly(modelId, true);
        done = 'Set as SFW-only';
        break;
      case 'unsetSfwOnly':
        result = await setReportedModelSfwOnly(modelId, false);
        done = 'Allowed NSFW on';
        break;
      case 'setPoi':
        result = await setReportedModelPoi(modelId, true);
        done = 'Flagged as a real person';
        break;
      case 'unsetPoi':
        result = await setReportedModelPoi(modelId, false);
        done = 'Unflagged as a real person';
        break;
      // Both directions behind the one grant: whoever may take a model down may bring it back.
      case 'takeDown':
      case 'bringBack':
        if (!locals.grants['model.takeDown']) return fail(403, { error: denied('model.takeDown') });
        result =
          action === 'takeDown'
            ? await takeDownReportedModel(modelId)
            : await bringBackReportedModel(modelId);
        done = action === 'takeDown' ? 'Taken down' : 'Brought back';
        break;
      default:
        return fail(400, { error: 'Unknown action.' });
    }
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true, moderated: `${done} model #${modelId}` };
  },
};
