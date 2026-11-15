import { dbWrite } from '~/server/db/client';
import { getResourceIdsWithActiveAccessTokens } from '~/server/services/access-token.service';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  isPublicArticle,
  isShareableArticleStatus,
} from '~/server/services/text-scan/public-content';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Article',
  labels: ['nsfw', 'csam'],
  category: {
    tagType: 'article',
    // Raw: no updatedAt bump, and the author's own pick in TagsOnArticle is never touched.
    write: async (entityId, tagId) => {
      await dbWrite.$executeRaw`
        UPDATE "Article" SET "systemCategoryId" = ${tagId} WHERE id = ${entityId}
      `;
    },
  },
  load: async (ids) => {
    const rows = await dbWrite.article.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        title: true,
        content: true,
        userNsfwLevel: true,
        status: true,
        scheduledAt: true,
      },
    });
    const shared = await getResourceIdsWithActiveAccessTokens(
      'Article',
      rows.filter((a) => isShareableArticleStatus(a.status)).map((a) => a.id)
    );
    return new Map(
      rows.map((a) => [
        a.id,
        {
          userId: a.userId,
          notPublic: !isPublicArticle(a, shared.has(a.id)),
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
