import type { LayoutServerLoad } from './$types';
import { getOwnerFlaggedMinorModelIds, getReportedModelStates } from '$lib/server/reports.service';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { canAccess } from '$lib/server/access';
import { ReportEntity } from '$lib/reports';

// The QUEUE, as a layout, so it keeps its data while the moderator moves between models — the model is
// the child route's path (`[modelId]`), which this never reads. As one page with `?model=`, every model
// click reran the queue, its status counts and every listed model's state.
//
// 🔴 The URL only through `loadReportQueue`, which reads it key by key. Iterating the query string or
// reading `url.pathname`/`params` here makes it rerun on every click again, and nothing would look
// broken except the speed.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const queue = await loadReportQueue(ReportEntity.Model, url, {
    statusCounts: true,
    canonicalize: false,
  });
  const entityIds = queue.items.flatMap((r) => (r.entityId != null ? [r.entityId] : []));
  const [ownerFlaggedMinor, models] = await Promise.all([
    getOwnerFlaggedMinorModelIds(entityIds),
    getReportedModelStates(entityIds),
  ]);

  return {
    ...queue,
    ownerFlaggedMinor,
    models,
    // The preview's training-data viewer: shown to whoever `/api/training-data` would serve, so a
    // moderator never gets a button that only answers 403.
    canViewTrainingData:
      canAccess(locals.user, '/audit/training-data') ||
      canAccess(locals.user, '/audit/training-models'),
    // The queue and the two detail columns each scroll on their own, sized against the viewport, which
    // `wide` cannot do — its padding puts the page an unknown distance down.
    fullBleed: true,
  };
};
