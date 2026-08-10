import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { recordModActivity } from '$lib/server/mod-activity';
import { getQueueStats, getSplitPoint, splitFrontPageQueue } from '$lib/server/queue-stats.service';

// Retool's Graphs tab, plus the Split control that sat with it. Kept off the dashboard deliberately:
// Retool put these behind a "Load Graphs" button because they are unindexed aggregates, and the
// dashboard is the page every moderator opens first.
export const load: PageServerLoad = async () => {
  const [stats, splitAt] = await Promise.all([getQueueStats(), getSplitPoint().catch(() => null)]);
  return { stats, splitAt, wide: true };
};

export const actions: Actions = {
  split: async ({ locals }) => {
    // Gated on this page's own path, never the /retool group — a group grant is the union of its
    // children, so gating on the parent would widen who can fork a live queue.
    if (!canAccess(locals.user, '/retool/queue-stats'))
      return fail(403, { error: 'Not permitted.' });

    const { at } = await splitFrontPageQueue();

    // The timers table has no room for who pressed it, so this is the only audit trail. Entity id 0:
    // the fork is a property of the queue, not of any one row.
    await recordModActivity({
      userId: locals.user.id,
      entityType: 'frontPageQueue',
      entityId: 0,
      activity: 'splitQueue',
    });

    return { success: true, at: at.toISOString() };
  },
};
