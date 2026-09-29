import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamSubject,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'Comment',
  labels: ['scam'],
  load: async (ids) => {
    // Primary, not replica: the scan is queued in the same request as the insert. `updatedAt`, not
    // `createdAt`: an edit is rescanned, and its text dates from the edit.
    const rows = await dbWrite.comment.findMany({
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
