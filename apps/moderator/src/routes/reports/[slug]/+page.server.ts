import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setReportStatus, getGameMirrors, getReportedGame } from '$lib/server/reports.service';
import { removePlacement } from '$lib/server/user-actions.service';
import { delistGame, delistReason } from '$lib/server/game-frame';
import {
  getReportedStorylines,
  getReportStorylineId,
  setStorylineTakedown,
} from '$lib/server/storyline-takedown.service';
import { canAccess } from '$lib/server/access';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { reportStatusActions } from '$lib/server/report-queue-actions';
import { reportEntityForSlug, reportPath, ReportStatus } from '$lib/reports';

// The table queues. Users, models and posts have their own routes (`/reports/user`, `/reports/model`,
// `/reports/post`), each a queue layout with the open item in the path; a static route wins over this
// one, so none of those slugs reaches here.
export const load: PageServerLoad = async ({ params, url }) => {
  const type = reportEntityForSlug(params.slug);
  if (!type) error(404, 'Unknown report type');

  const queue = await loadReportQueue(type, url);
  const entityIds = queue.items.flatMap((r) => (r.entityId != null ? [r.entityId] : []));
  const [games, storylines] = await Promise.all([
    type === 'gameFrameGame' ? getGameMirrors(entityIds) : [],
    type === 'storyline' ? getReportedStorylines(entityIds) : [],
  ]);

  return { ...queue, wide: true, games, storylines };
};

// Access is gated globally in hooks.server.ts (route-tier check), so actions don't re-check here.
export const actions: Actions = {
  ...reportStatusActions(),
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
   * Takes the reported storyline down, then sets the report Actioned (which pays the reporters).
   * Held as a moderator's takedown, so a clean rescan of its title cannot lift it. Already down by
   * a moderator still actions the report: the content it is about is down.
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
   * Lifts a moderator's takedown. The report's status is left as it is. A takedown the title scan
   * holds is not lifted here, so the storyline can stay down, and the moderator is told so.
   */
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
};
