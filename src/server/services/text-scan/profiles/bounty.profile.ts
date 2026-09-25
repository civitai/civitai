import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Bounty',
  labels: ['nsfw', 'poi'],
  load: async (ids) => {
    const rows = await dbWrite.bounty.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        name: true,
        description: true,
        nsfw: true,
        nsfwLevel: true,
        poi: true,
      },
    });
    return new Map(
      rows.map((b) => [
        b.id,
        {
          userId: b.userId ?? undefined,
          declared: { nsfwLevel: b.nsfw ? NsfwLevel.XXX : b.nsfwLevel, poi: b.poi },
          fields: [
            { heading: 'Name', text: b.name },
            { heading: 'Description', text: b.description ? removeTags(b.description) : null },
          ],
        },
      ])
    );
  },
});
