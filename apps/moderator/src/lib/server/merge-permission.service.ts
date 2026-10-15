import {
  MERGE_PERMISSION_REPORT_REASON,
  mergePermissionAt,
  type MergePermissionVerdict,
} from '@civitai/shared/merge-permission';
import { dbRead } from './db';

/**
 * "Was this merge allowed when it was made?" for merge-permission reports: each version of the
 * reported merge, judged by the source model's `allowDerivatives` at the moment that version was
 * published (or created, if never published).
 */
export type MergePermissionCheck = {
  sourceModelId: number;
  source: { id: number; name: string; allowDerivatives: boolean } | null;
  /** The source's merge permission over time, oldest first. Empty: unchanged since `knownSince`. */
  timeline: { effectiveAt: Date; allowDerivatives: boolean }[];
  versions: { id: number; name: string; madeAt: Date; verdict: MergePermissionVerdict }[];
};

type ReportLike = { id: number; entityId: number | null; details: unknown };
type SourceRow = { id: number; name: string; createdAt: Date; allowDerivatives: boolean };
type SnapshotRow = { modelId: number; effectiveAt: Date; allowDerivatives: boolean };
type VersionRow = {
  id: number;
  modelId: number;
  name: string;
  createdAt: Date;
  publishedAt: Date | null;
};

/** The source model a report names, if it is a merge-permission report. */
export function mergeReportSource(details: unknown): number | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const { reason, sourceModelId } = details as { reason?: unknown; sourceModelId?: unknown };
  if (reason !== MERGE_PERMISSION_REPORT_REASON) return undefined;
  return typeof sourceModelId === 'number' && sourceModelId > 0 ? sourceModelId : undefined;
}

export function buildMergePermissionChecks({
  reports,
  sources,
  snapshots,
  versions,
}: {
  reports: ReportLike[];
  sources: SourceRow[];
  snapshots: SnapshotRow[];
  versions: VersionRow[];
}): Record<number, MergePermissionCheck> {
  const checks: Record<number, MergePermissionCheck> = {};
  for (const report of reports) {
    const sourceModelId = mergeReportSource(report.details);
    if (!sourceModelId || report.entityId == null) continue;
    const source = sources.find((s) => s.id === sourceModelId);
    const timeline = snapshots
      .filter((s) => s.modelId === sourceModelId)
      .map(({ effectiveAt, allowDerivatives }) => ({ effectiveAt, allowDerivatives }))
      .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());

    checks[report.id] = {
      sourceModelId,
      source: source
        ? { id: source.id, name: source.name, allowDerivatives: source.allowDerivatives }
        : null,
      timeline,
      versions: source
        ? versions
            .filter((v) => v.modelId === report.entityId)
            .map((v) => {
              const madeAt = v.publishedAt ?? v.createdAt;
              return {
                id: v.id,
                name: v.name,
                madeAt,
                verdict: mergePermissionAt({
                  at: madeAt,
                  snapshots: timeline,
                  current: source,
                  sourceCreatedAt: source.createdAt,
                }),
              };
            })
            .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime())
        : [],
    };
  }
  return checks;
}

export async function getMergePermissionChecks(
  reports: ReportLike[]
): Promise<Record<number, MergePermissionCheck>> {
  const merge = reports.filter((r) => r.entityId != null && mergeReportSource(r.details));
  if (!merge.length) return {};
  const sourceIds = [...new Set(merge.map((r) => mergeReportSource(r.details) as number))];
  const mergeIds = [...new Set(merge.map((r) => r.entityId as number))];

  const [sources, snapshots, versions] = await Promise.all([
    dbRead
      .selectFrom('Model')
      .select(['id', 'name', 'createdAt', 'allowDerivatives'])
      .where('id', 'in', sourceIds)
      .where('deletedAt', 'is', null)
      .execute(),
    dbRead
      .selectFrom('ModelPermissionSnapshot')
      .select(['modelId', 'effectiveAt', 'allowDerivatives'])
      .where('modelId', 'in', sourceIds)
      .execute(),
    dbRead
      .selectFrom('ModelVersion')
      .select(['id', 'modelId', 'name', 'createdAt', 'publishedAt'])
      .where('modelId', 'in', mergeIds)
      .execute(),
  ]);
  return buildMergePermissionChecks({ reports: merge, sources, snapshots, versions });
}
