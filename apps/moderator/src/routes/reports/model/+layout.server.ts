import type { LayoutServerLoad } from './$types';
import { getOwnerFlaggedMinorModelIds, getReportedModelStates } from '$lib/server/reports.service';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { canViewTrainingData } from '$lib/server/access';
import { ReportEntity } from '$lib/reports';
import { getMergePermissionChecks } from '$lib/server/merge-permission.service';

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
  const [ownerFlaggedMinor, models, mergePermission] = await Promise.all([
    getOwnerFlaggedMinorModelIds(entityIds),
    getReportedModelStates(entityIds),
    // For the queue's rows too: the open model lists any of its reports the queue is showing, a
    // resolved one included, and the item's own load covers only the open ones. Nothing is read unless
    // a row is a merge-permission report.
    getMergePermissionChecks(queue.items),
  ]);

  return {
    ...queue,
    ownerFlaggedMinor,
    models,
    mergePermission,
    canViewTrainingData: canViewTrainingData(locals.user),
    // The queue and the two detail columns each scroll on their own, sized against the viewport, which
    // `wide` cannot do — its padding puts the page an unknown distance down.
    fullBleed: true,
    headerInline: true,
  };
};
