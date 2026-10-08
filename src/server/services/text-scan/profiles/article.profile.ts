import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Article',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.article.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, title: true, content: true, userNsfwLevel: true },
    });
    return new Map(
      rows.map((a) => [
        a.id,
        {
          userId: a.userId,
          declared: { nsfwLevel: a.userNsfwLevel },
          fields: [
            { heading: 'Title', text: a.title },
            { heading: 'Content', text: a.content ? removeTags(a.content) : null },
          ],
        },
      ])
    );
  },
});
