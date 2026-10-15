import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setReportStatus, getGameMirrors, getReportedGame } from '$lib/server/reports.service';
import { getResolvedPostReportIds } from '$lib/server/moderation-board.service';
import { removePlacement } from '$lib/server/user-actions.service';
import { delistGame, delistReason } from '$lib/server/game-frame';
import { canAccess } from '$lib/server/access';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { reportStatusActions } from '$lib/server/report-queue-actions';
import { reportEntityForSlug, reportPath, ReportStatus } from '$lib/reports';

// The table queues. Users and models have their own routes (`/reports/user`, `/reports/model`), each a
// queue layout with the open item in the path; a static route wins over this one, so neither slug
// reaches here.
export const load: PageServerLoad = async ({ params, url }) => {
  const type = reportEntityForSlug(params.slug);
  if (!type) error(404, 'Unknown report type');

  const queue = await loadReportQueue(type, url);
  const entityIds = queue.items.flatMap((r) => (r.entityId != null ? [r.entityId] : []));
  const games = type === 'gameFrameGame' ? await getGameMirrors(entityIds) : [];

  return { ...queue, wide: true, games };
};

// Access is gated globally in hooks.server.ts (route-tier check), so actions don't re-check here.
export const actions: Actions = {
  ...reportStatusActions(),
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
};
