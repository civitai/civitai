import { dbWrite } from '~/server/db/client';
import { VISIBLE_COLLECTION_WHERE } from '~/server/services/text-scan/collection-visibility';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Collection',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.collection.findMany({
      where: { id: { in: ids }, ...VISIBLE_COLLECTION_WHERE },
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
