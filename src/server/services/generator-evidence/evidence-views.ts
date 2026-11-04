import { dbWrite } from '~/server/db/client';
import { isGeneratorEvidenceDetails } from '~/server/services/generator-evidence/evidence-meta';
import { CsamReportType } from '~/shared/utils/prisma/enums';

export const evidenceViewActivity = (blobId: string) => `generatorEvidence:view:${blobId}` as const;

/**
 * Each file's moderator views, by blob id, read from the primary so a fresh view counts. A file
 * reported again (a supplemental report) was viewed if a moderator viewed it on any of the user's
 * evidence reports, but a view on an earlier report counts only where that report held the same
 * bytes.
 */
export async function getViewedEvidence(
  report: { id: number; userId: number | null },
  blobs: { blobId: string; sha256?: string }[]
) {
  const viewed = new Map<string, number[]>();
  if (!blobs.length) return viewed;
  const reportIds =
    report.userId == null
      ? [report.id]
      : (
          await dbWrite.csamReport.findMany({
            where: { userId: report.userId, type: CsamReportType.GeneratedImage },
            select: { id: true },
          })
        ).map(({ id }) => id);
  if (!reportIds.includes(report.id)) reportIds.push(report.id);

  const rows = await dbWrite.modActivity.findMany({
    where: {
      entityType: 'csamReport',
      entityId: { in: reportIds },
      activity: { in: blobs.map(({ blobId }) => evidenceViewActivity(blobId)) },
    },
    select: { activity: true, userId: true, entityId: true },
  });

  const earlierIds = [
    ...new Set(
      rows.flatMap(({ entityId }) => (entityId && entityId !== report.id ? [entityId] : []))
    ),
  ];
  const earlierSha = new Map<string, string>();
  if (earlierIds.length) {
    const earlier = await dbWrite.csamReport.findMany({
      where: { id: { in: earlierIds } },
      select: { id: true, details: true },
    });
    for (const { id, details } of earlier) {
      if (!isGeneratorEvidenceDetails(details)) continue;
      for (const job of details.generatedImages)
        for (const blob of job.blobs)
          if (blob.status === 'preserved' && blob.sha256)
            earlierSha.set(`${id}|${blob.blobId}`, blob.sha256);
    }
  }

  const shaOf = new Map(blobs.map(({ blobId, sha256 }) => [blobId, sha256]));
  const prefix = evidenceViewActivity('');
  for (const { activity, userId, entityId } of rows) {
    const blobId = activity.slice(prefix.length);
    if (entityId !== report.id) {
      const sha = shaOf.get(blobId);
      if (!sha || earlierSha.get(`${entityId}|${blobId}`) !== sha) continue;
    }
    viewed.set(blobId, [...(viewed.get(blobId) ?? []), ...(userId ? [userId] : [])]);
  }
  return viewed;
}
