import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, title: true, detail: true, nsfwLevel: true },
    });
    return new Map(
      rows.map((p) => [
        p.id,
        {
          userId: p.userId,
          declared: { nsfwLevel: p.nsfwLevel },
          fields: [
            { heading: 'Title', text: p.title },
            { heading: 'Detail', text: p.detail ? removeTags(p.detail) : null },
          ],
        },
      ])
    );
  },
});
