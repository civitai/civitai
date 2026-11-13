import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamSubject,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'ResourceReview',
  labels: ['scam'],
  minChars: 25,
  load: async (ids) => {
    const rows = await dbWrite.resourceReview.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, details: true, updatedAt: true },
    });
    const eligible = await scamEligibleAuthors(rows.map((row) => row.userId));
    return new Map(
      rows
        .filter((row) => eligible.has(row.userId))
        .map((row) => [
          row.id,
          scamSubject(row.userId, [{ heading: 'Review', text: scamTextFromHtml(row.details) }], {
            contentAt: row.updatedAt.toISOString(),
          }),
        ])
    );
  },
});
