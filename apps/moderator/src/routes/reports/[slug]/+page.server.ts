import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setReportStatus, getGameMirrors, getReportedGame } from '$lib/server/reports.service';
import { delistGame, delistReason } from '$lib/server/game-frame';
import {
  getReportedStorylines,
  getReportStorylineId,
  getStorylineReportHolds,
  setStorylineTakedown,
} from '$lib/server/storyline-takedown.service';
import { liftStorylineScanTakedown } from '$lib/server/storyline-scan-lift.service';
import {
  getReportedServiceOfferings,
  getReportServiceOfferingId,
  takedownServiceOffering,
} from '$lib/server/service-offering-takedown.service';
import { isServiceOfferingTakedownReason } from '@civitai/shared/service-offering-takedown';
import { canAccess } from '$lib/server/access';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { reportStatusActions } from '$lib/server/report-queue-actions';
import { reportEntityForSlug, reportPath, ReportStatus } from '$lib/reports';

// The table queues. Users, models and posts have their own routes (`/reports/user`, `/reports/model`,
// `/reports/post`), each a queue layout with the open item in the path, and images theirs
// (`/reports/image`, the image queues' card grid); a static route wins over this one, so none of those
// slugs reaches here. Articles, chats, collections, bounties and bounty entries share the same layout at
// `/reports/[queue=entityQueue]`, whose matcher outranks this plain param.
export const load: PageServerLoad = async ({ params, url }) => {
  const type = reportEntityForSlug(params.slug);
  if (!type) error(404, 'Unknown report type');

  const queue = await loadReportQueue(type, url);
  const entityIds = queue.items.flatMap((r) => (r.entityId != null ? [r.entityId] : []));
  const [games, storylines, storylineHolds, serviceOfferings] = await Promise.all([
    type === 'gameFrameGame' ? getGameMirrors(entityIds) : [],
    type === 'storyline' ? getReportedStorylines(entityIds) : [],
    type === 'storyline' ? getStorylineReportHolds(queue.items.map((r) => r.id)) : [],
    type === 'serviceOffering' ? getReportedServiceOfferings(entityIds) : [],
  ]);

  return { ...queue, wide: true, games, storylines, storylineHolds, serviceOfferings };
};

// The page's route tier is gated in hooks.server.ts; actions on a type with its own tier re-check it here with canAccess.
export const actions: Actions = {
  ...reportStatusActions(),
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
   * Takes the reported storyline down, then sets the report Actioned (which pays the reporters).
   * Already down by a moderator still actions the report.
   */
  takeDownStoryline: async ({ request, locals, params, getClientAddress }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'storyline' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });

    const storylineId = await getReportStorylineId(id);
    if (!storylineId) return fail(410, { error: 'That report no longer exists.', gone: true });
    const storyline = await setStorylineTakedown({
      storylineId,
      takenDown: true,
      moderatorId: locals.user.id,
    });
    if (!storyline) return fail(410, { error: 'That storyline no longer exists.', gone: true });

    const result = await setReportStatus({
      id,
      status: ReportStatus.Actioned,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    if (!result.ok) return fail(410, { error: `Taken down, but ${result.error}`, gone: true });
    return {
      success: true,
      storylineTakedown: storyline.changed ? 'Taken down' : 'Already taken down',
    };
  },

  /**
   * Takes the reported Creator Services offering down with a reason, then sets the report Actioned
   * (which pays the reporters). Already taken down still actions the report: the content it is about
   * is down. There is no restore.
   */
  takeDownServiceOffering: async ({ request, locals, params, getClientAddress }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'serviceOffering' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });
    const reason = data.get('reason');
    if (!isServiceOfferingTakedownReason(reason)) return fail(400, { error: 'Pick a reason.' });
    const details =
      String(data.get('details') ?? '')
        .trim()
        .slice(0, 1000) || null;
    // `other` has no copy of its own, so the details are what the seller is told.
    if (reason === 'other' && !details)
      return fail(400, { error: 'Say what is wrong when the reason is Other.' });

    const offeringId = await getReportServiceOfferingId(id);
    if (!offeringId) return fail(410, { error: 'That report no longer exists.', gone: true });
    const offering = await takedownServiceOffering({
      offeringId,
      reason,
      details,
      moderatorId: locals.user.id,
    });
    if (!offering) return fail(410, { error: 'That service no longer exists.', gone: true });

    const result = await setReportStatus({
      id,
      status: ReportStatus.Actioned,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    if (!result.ok) return fail(410, { error: `Taken down, but ${result.error}`, gone: true });
    return {
      success: true,
      serviceOfferingTakedown: offering.changed ? 'Taken down' : 'Already taken down',
    };
  },

  /** Leaves the report's status as it is. */
  restoreStoryline: async ({ request, locals, params }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'storyline' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });

    const storylineId = await getReportStorylineId(id);
    if (!storylineId) return fail(410, { error: 'That report no longer exists.', gone: true });
    const storyline = await setStorylineTakedown({
      storylineId,
      takenDown: false,
      moderatorId: locals.user.id,
    });
    if (!storyline) return fail(410, { error: 'That storyline no longer exists.', gone: true });
    return {
      success: true,
      storylineTakedown: !storyline.changed
        ? 'Nothing to restore'
        : storyline.tosViolation
        ? 'Restored, but its title scan still keeps it down'
        : 'Restored',
    };
  },

  /**
   * Lifts the title scan's takedown for the title the moderator read (the form carries it), so an
   * edit made since is refused rather than waved through. The report's status is left as it is.
   */
  liftStorylineScanTakedown: async ({ request, locals, params }) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'storyline' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });
    const reviewedTitle = data.get('reviewedTitle');
    if (typeof reviewedTitle !== 'string') return fail(400, { error: 'Invalid title.' });

    const storylineId = await getReportStorylineId(id);
    if (!storylineId) return fail(410, { error: 'That report no longer exists.', gone: true });
    const lifted = await liftStorylineScanTakedown({
      storylineId,
      reviewedTitle,
      moderatorId: locals.user.id,
    });
    if (!lifted.ok) return fail(409, { error: lifted.error });
    return {
      success: true,
      storylineTakedown: lifted.tosViolation
        ? "Lifted the title scan's takedown; a moderator's takedown keeps it down"
        : 'Lifted',
    };
  },
};
