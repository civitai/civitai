import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamSubject,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'CommentV3',
  labels: ['scam', 'csam'],
  load: async (ids) => {
    const rows = await dbWrite.$queryRaw<
      { id: number; entityType: string; userId: number; content: string; updatedAt: Date }[]
    >`
      SELECT id, "entityType"::text AS "entityType", "userId", content, "updatedAt" FROM "CommentV3"
      WHERE id = ANY(${ids}::int[]) AND "deletedAt" IS NULL
    `;
    const eligible = await scamEligibleAuthors(rows.map((row) => row.userId));
    return new Map(
      rows
        // Feature Pages comments are scanned whoever wrote them (shown at once, hidden if flagged).
        .filter((row) => row.entityType === 'featurePage' || eligible.has(row.userId))
        .map((row) => [
          row.id,
          scamSubject(row.userId, [{ heading: 'Comment', text: scamTextFromHtml(row.content) }], {
            contentAt: row.updatedAt.toISOString(),
          }),
        ])
    );
  },
});
