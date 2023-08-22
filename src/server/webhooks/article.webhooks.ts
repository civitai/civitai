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
      const articles = await prisma.article.findMany({
        where: {
          publishedAt: {
            gt: lastSent,
            lte: now,
          },
        },
        select: articleDetailSelect,
      });
      if (!articles.length) return [];

      const articleCategories = await getCategoryTags('article');
      return articles.map(({ cover, user, tags: allTags, ...article }) => {
        const categories: string[] = [];
        const tags: string[] = [];
        for (const { tag } of allTags) {
          if (articleCategories.some((c) => c.id === tag.id)) categories.push(tag.name);
          else tags.push(tag.name);
        }

        return {
          ...article,
          type: categories[0] ?? 'article',
          tags,
          cover: cover ? getEdgeUrl(cover, { width: 450 }) : null,
          creator: {
            username: user.username,
            image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
          },
          link: `${baseUrl}/articles/${article.id}`,
        };
      });
    },
  },
});
