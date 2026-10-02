import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamSubject,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'CommentV2',
  labels: ['scam'],
  load: async (ids) => {
    const rows = await dbWrite.commentV2.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, content: true, updatedAt: true },
    });
    const eligible = await scamEligibleAuthors(rows.map((row) => row.userId));
    return new Map(
      rows
        .filter((row) => eligible.has(row.userId))
        .map((row) => [
          row.id,
          scamSubject(row.userId, [{ heading: 'Comment', text: scamTextFromHtml(row.content) }], {
            contentAt: row.updatedAt.toISOString(),
          }),
        ])
    );
  },
});
