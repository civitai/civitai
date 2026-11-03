import { dbWrite } from '~/server/db/client';

export const evidenceViewActivity = (blobId: string) => `generatorEvidence:view:${blobId}` as const;

/** Each file's moderator views on a report, by blob id, from the primary so a fresh view counts. */
export async function getViewedEvidence(reportId: number, blobIds: string[]) {
  const viewed = new Map<string, number[]>();
  if (!blobIds.length) return viewed;
  const rows = await dbWrite.modActivity.findMany({
    where: {
      entityType: 'csamReport',
      entityId: reportId,
      activity: { in: blobIds.map(evidenceViewActivity) },
      createdAt: { lt: new Date() },
    },
    select: { activity: true, userId: true },
  });
  const prefix = evidenceViewActivity('');
  for (const { activity, userId } of rows) {
    const blobId = activity.slice(prefix.length);
    viewed.set(blobId, [...(viewed.get(blobId) ?? []), ...(userId ? [userId] : [])]);
  }
  return viewed;
}
