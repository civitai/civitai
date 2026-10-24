import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Crucible',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.crucible.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, name: true, description: true, nsfwLevel: true },
    });
    return new Map(
      rows.map((c) => [
        c.id,
        {
          userId: c.userId,
          declared: { nsfwLevel: c.nsfwLevel },
          fields: [
            { heading: 'Name', text: c.name },
            { heading: 'Description', text: c.description ? removeTags(c.description) : null },
          ],
        },
      ])
    );
  },
});
