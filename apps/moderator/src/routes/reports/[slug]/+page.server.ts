import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  getReports,
  setReportStatus,
  updateReportNotes,
  getGameMirrors,
  getOwnerFlaggedMinorModelIds,
  getReportedGame,
  getReportedModelId,
  getReportedModelStates,
} from '$lib/server/reports.service';
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
import { getResolvedPostReportIds } from '$lib/server/moderation-board.service';
import { removePlacement } from '$lib/server/user-actions.service';
import { delistGame, delistReason } from '$lib/server/game-frame';
import { canAccess } from '$lib/server/access';
import {
  getMergePermissionChecks,
  type MergePermissionCheck,
} from '$lib/server/merge-permission.service';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  reportEntityForSlug,
  reportPath,
  reportReasons,
  reportStatuses,
  ReportStatus,
  type ReportReason,
} from '$lib/reports';

const isStatus = (v: string): v is ReportStatus => (reportStatuses as string[]).includes(v);
const isReason = (v: string): v is ReportReason => (reportReasons as string[]).includes(v);

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const type = reportEntityForSlug(params.slug);
  if (!type) error(404, 'Unknown report type');

  // `?report=<id>` opens ONE report, from a page that could only list it. Its filters are forced to
  // `all`: a report linked to from elsewhere is usually already handled, and landing on an empty list
  // because the default view is Pending+Processing reads as "that report does not exist".
  const reportId = Number(url.searchParams.get('report')) || undefined;

  // Canonicalize a bare landing so the active default filters are explicit (and shareable) in the URL.
  // Only absent params get defaults — a present-but-empty `?status=` is a deliberate clear, left alone.
  if (!reportId && !url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_REPORT_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const urlStatuses = url.searchParams.getAll('status').filter(isStatus);
  const urlReasons = url.searchParams.getAll('reason').filter(isReason);
  const reportedBy = url.searchParams.get('reportedBy')?.trim() || '';

  // A present-but-empty param (`?status=`/`?reason=`) is an explicit clear → all; an absent param → the
  // default review view. Both defaults must stay equal to what the badge counts, or a moderator lands on
  // a list that disagrees with the number they clicked.
  const statuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_REPORT_STATUSES;
  const reasons = url.searchParams.has('reason') ? urlReasons : DEFAULT_REPORT_REASONS;

  const data = await getReports({
    type,
    page,
    // An empty selection is every one, said explicitly rather than implied by omission.
    statuses: reportId ? 'all' : statuses.length ? statuses : 'all',
    reasons: reportId ? 'all' : reasons.length ? reasons : 'all',
    reportedBy: reportedBy || undefined,
    reportId,
  });
  const entityIds = data.items.flatMap((r) => (r.entityId != null ? [r.entityId] : []));
  const games = type === 'gameFrameGame' ? await getGameMirrors(entityIds) : [];
  const [ownerFlaggedMinor, models, mergePermission] =
    type === 'model'
      ? await Promise.all([
          getOwnerFlaggedMinorModelIds(entityIds),
          getReportedModelStates(entityIds),
          getMergePermissionChecks(data.items),
        ])
      : [[], [], {} as Record<number, MergePermissionCheck>];

  // The default reason set is NOT echoed into the filter control: eight pre-ticked chips read as a
  // heavily-narrowed view when it is the ordinary one. The page says what it is hiding instead, and only
  // while it is hiding it — once reasons are chosen explicitly, the choice is the whole story.
  return {
    type,
    // The model layout owns its height: the queue and the two detail columns each scroll on their own,
    // sized against the viewport, which `wide` cannot do — its padding puts the page an unknown
    // distance down. Every other type keeps the full-width table it had.
    ...(type === 'model' ? { fullBleed: true } : { wide: true }),
    // The preview's training-data viewer: shown to whoever `/api/training-data` would serve, so a
    // moderator never gets a button that only answers 403.
    canViewTrainingData:
      type === 'model' &&
      (canAccess(locals.user, '/audit/training-data') ||
        canAccess(locals.user, '/audit/training-models')),
    // A `?report=` view ran with no status/reason filter, so echoing the defaults would put chips
    // saying "Pending + Processing" above an Actioned row and a note about hiding Automated above an
    // Automated one — the operator reads that as the filters being broken.
    statuses: reportId ? [] : statuses,
    reasons: urlReasons,
    hidingAutomated: !reportId && !url.searchParams.has('reason'),
    reportedBy,
    games,
    ownerFlaggedMinor,
    models,
    mergePermission,
    ...data,
  };
};

// Access is gated globally in hooks.server.ts (route-tier check), so actions don't re-check here.
export const actions: Actions = {
  setStatus: async ({ request, locals, getClientAddress }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    const status = String(data.get('status'));
    if (!id || !isStatus(status)) return fail(400, { error: 'Invalid input' });

    // `setReportStatus` RETURNS its outcome; discarding it reported success for a report another
    // moderator had already actioned or deleted. Same defect the batch sweep had — and this is the
    // path used all day.
    const result = await setReportStatus({
      id,
      status,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    // `gone` rather than a bare message: the page reloads the queue on it, so the row the moderator
    // is looking at leaves the screen instead of sitting there accepting further clicks.
    if (!result.ok) return fail(410, { error: result.error, gone: true });
    if (!result.changed)
      return fail(409, { error: 'Someone else already set that status. Reload.' });
    return { success: true };
  },
  /**
   * Retool's `ActionAllPostReports`. Post reports whose post is already entirely blocked are resolved
   * by the content — the row is open only because nobody clicked it. Retool swept them in one go; the
   * port had the verb (`setStatus`) and not the SELECT, so the sweep had to be done by hand.
   *
   * Actioned, not Unactioned: the content WAS removed, so the report was correct.
   */
  actionResolvedPosts: async ({ locals, getClientAddress }) => {
    const ids = await getResolvedPostReportIds();
    if (!ids.length)
      return fail(400, { error: 'No post reports are already resolved by content.' });

    // `setReportStatus` RETURNS its outcome rather than throwing: `ok:false` when the report is gone,
    // and `ok:true, changed:false` when someone else already put it in this status. Counting the loop
    // instead of the results reported "actioned N of N" for a run that changed nothing.
    let actioned = 0;
    let skipped = 0;
    for (const id of ids) {
      const result = await setReportStatus({
        id,
        status: ReportStatus.Actioned,
        userId: locals.user.id,
        ip: getClientAddress(),
      });
      if (result.ok && result.changed) actioned += 1;
      else skipped += 1;
    }

    // The SELECT is capped, so a full batch means there are probably more behind it.
    return { success: true, actioned, skipped, found: ids.length, more: ids.length === 500 };
  },

  /**
   * The removal path main added with the `StickerPlacement` reason (#3766). Delegated, not
   * reimplemented: the service settles escrow, and that must have one implementation.
   */
  removePlacement: async ({ request, locals }) => {
    // Acting on reported content, not merely reading the queue — gated on its own path.
    if (!canAccess(locals.user, '/reports')) return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const placementId = Number(data.get('placementId'));
    if (!Number.isInteger(placementId) || placementId <= 0)
      return fail(400, { error: 'Invalid placement.' });

    const result = await removePlacement({ placementId, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true, placementRemoved: placementId };
  },

  /**
   * Delists the reported game on Game Frame, then sets the report Actioned (which pays the reporters).
   * The report is only touched once Game Frame says the game is down, so a failed call leaves it open.
   */
  delistGame: async ({ request, locals, params, getClientAddress }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'gameFrameGame' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });

    const game = await getReportedGame(id);
    if (!game) return fail(410, { error: 'That report no longer exists.', gone: true });

    const outcome = await delistGame({
      slug: game.slug,
      reason: delistReason(game, id),
      reportId: id,
      moderator: { id: locals.user.id, username: locals.user.username ?? null },
    });
    if (!outcome.ok) return fail(outcome.status, { error: outcome.message });

    const forks = outcome.affected ? ` (+${outcome.affected} forks)` : '';
    const result = await setReportStatus({
      id,
      status: ReportStatus.Actioned,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    if (!result.ok)
      return fail(410, { error: `Delisted${forks}, but ${result.error}`, gone: true });
    return { success: true, delisted: `Delisted${forks}` };
  },

  /**
   * Acts on the reported model through the main app — the model page's moderator menu without the
   * second tab. It does NOT touch the report: closing it is the panel's Report status buttons, a
   * separate decision. Doing both in one click took the report out of the queue before its result
   * could be seen, made a second action on the same model impossible from the panel, and paid the
   * reporters (Actioned does) as a side effect of a model button.
   *
   * The model is read from the REPORT, never the form — a stale tab must not act on one model while
   * a moderator believes they are looking at another.
   */
  moderateModel: async ({ request, locals, params }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'model' || !canAccess(locals.user, reportPath(type)))
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

  saveNotes: async ({ request }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!id) return fail(400, { error: 'Invalid input' });

    const internalNotes = String(data.get('internalNotes') ?? '').trim() || null;
    // Discarding the outcome reports success for notes that were never stored, because the report
    // was deleted while they were being typed.
    const result = await updateReportNotes({ id, internalNotes });
    if (!result.ok)
      return fail(410, { error: 'That report was deleted while you were editing.', gone: true });
    return { success: true };
  },
};
