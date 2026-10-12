import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'BountyEntry',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.bountyEntry.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, description: true, nsfwLevel: true },
    });
    return new Map(
      rows.map((e) => [
        e.id,
        {
          userId: e.userId ?? undefined,
          declared: { nsfwLevel: e.nsfwLevel },
          fields: [
            { heading: 'Description', text: e.description ? removeTags(e.description) : null },
          ],
        },
      ])
    );
  },
});
