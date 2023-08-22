import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { getCategoryTags } from '~/server/services/system-cache';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

const baseUrl = getBaseUrl();
export const articleWebhooks = createWebhookProcessor({
  'new-article': {
    displayName: 'New Articles',
    getData: async ({ lastSent, prisma }) => {
      const now = new Date();
      const articles = await prisma.model.findMany({
        where: {
          publishedAt: {
            gt: lastSent,
            lte: now,
          },
          deletedAt: null,
        },
        select: articleDetailSelect,
      });
      if (!articles.length) return [];

      const articleCategories = await getCategoryTags('article');
      return articles.map(({ cover, user, tags, ...article }) => ({
        ...article,
        tags: tags.map(({ tag }) => ({
          ...tag,
          isCategory: articleCategories.some((c) => c.id === tag.id),
        })),
        cover: cover ? getEdgeUrl(cover, { width: 450 }) : null,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        link: `${baseUrl}/articles/${article.id}`,
      }));
    },
  },
});
