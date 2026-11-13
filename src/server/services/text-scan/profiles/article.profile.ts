import { dbWrite } from '~/server/db/client';
import { getResourceIdsWithActiveAccessTokens } from '~/server/services/access-token.service';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  isPublicArticle,
  isShareableArticleStatus,
} from '~/server/services/text-scan/public-content';
import { articleTextScanFields } from '~/server/services/article-ingestion.helpers';

registerTextScanProfile({
  entityType: 'Article',
  labels: ['nsfw', 'csam'],
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
          fields: articleTextScanFields(a.title, a.content),
        },
      ])
    );
  },
});
