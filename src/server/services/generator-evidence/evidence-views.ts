import { dbWrite } from '~/server/db/client';
import { GENERATOR_EVIDENCE_VERSION } from '~/server/services/generator-evidence/evidence-meta';
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
  const prefix = evidenceViewActivity('');
  const earlierSha = new Map<string, string>();
  if (earlierIds.length) {
    const viewedBlobIds = [...new Set(rows.map(({ activity }) => activity.slice(prefix.length)))];
    // Only the viewed files' hashes, not the whole details: `details.userActivity` can be large.
    const earlier = await dbWrite.$queryRaw<{ id: number; blobId: string; sha256: string }[]>`
      SELECT r.id, b->>'blobId' AS "blobId", b->>'sha256' AS sha256
      FROM "CsamReport" r
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.details->'generatedImages') = 'array'
          THEN r.details->'generatedImages' ELSE '[]'::jsonb END
      ) j
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(j->'blobs') = 'array' THEN j->'blobs' ELSE '[]'::jsonb END
      ) b
      WHERE r.id = ANY(${earlierIds}::int[])
        AND r.details->'generatorEvidence'->'version' = to_jsonb(${GENERATOR_EVIDENCE_VERSION}::int)
        AND b->>'status' = 'preserved'
        AND b->>'blobId' = ANY(${viewedBlobIds}::text[])
        AND coalesce(b->>'sha256', '') <> ''
    `;
    for (const { id, blobId, sha256 } of earlier) earlierSha.set(`${id}|${blobId}`, sha256);
  }

  const shaOf = new Map(blobs.map(({ blobId, sha256 }) => [blobId, sha256]));
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
