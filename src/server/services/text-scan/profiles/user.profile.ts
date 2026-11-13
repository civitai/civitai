import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { scamEligibleAuthors, scamSubject } from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'User',
  labels: ['scam'],
  load: async (ids) => {
    const rows = await dbWrite.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, username: true },
    });
    const named = rows.filter((row): row is { id: number; username: string } => !!row.username);
    const eligible = await scamEligibleAuthors(
      named.map((row) => row.id),
      { ignoreAccountAge: true }
    );
    return new Map(
      named
        .filter((row) => eligible.has(row.id))
        .map((row) => [row.id, scamSubject(row.id, [{ heading: 'Username', text: row.username }])])
    );
  },
});
