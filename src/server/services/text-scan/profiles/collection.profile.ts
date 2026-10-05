import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { Availability, CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { removeTags } from '~/utils/string-helpers';

// The set updateCollectionsNsfwLevels rates; anything else has no audience to protect.
const VISIBLE = {
  availability: Availability.Public,
  read: { in: [CollectionReadConfiguration.Public, CollectionReadConfiguration.Unlisted] },
};

registerTextScanProfile({
  entityType: 'Collection',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.collection.findMany({
      where: { id: { in: ids }, ...VISIBLE },
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
