import { getOwnerFlaggedMinorModelIds, getReportedModelStates } from '$lib/server/reports.service';
import { loadItemReports } from '$lib/server/report-queue-load';
import { ReportEntity } from '$lib/reports';
import { getMergePermissionChecks } from '$lib/server/merge-permission.service';

/**
 * The open model's half of the page: its open reports, its state and its owner's minor flag. The
 * queue is the layout's and does not rerun when the model changes; this reruns on nothing else.
 * Shared by the bare `/reports/model`, which opens the queue's first model, and `[modelId]`.
 *
 * Its own state rather than the layout's per-row lookup: the path can name a model that is not on the
 * current page of the queue, which read as "This model no longer exists".
 */
export async function loadModelItem(modelId: number) {
  const [reports, [model], ownerFlagged] = await Promise.all([
    loadItemReports(ReportEntity.Model, modelId),
    getReportedModelStates([modelId]),
    getOwnerFlaggedMinorModelIds([modelId]),
  ]);
  return {
    modelId,
    reports,
    // "Was this merge allowed when it was made?", for the merge-permission reports among them.
    mergePermission: await getMergePermissionChecks(reports),
    model: model ?? null,
    ownerFlaggedMinor: ownerFlagged.includes(modelId),
  };
}

export type ModelItem = Awaited<ReturnType<typeof loadModelItem>>;
