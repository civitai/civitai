import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { articleNotifications } from '~/server/notifications/article.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';

export const articleDetailFetcher = createDetailFetcher({
  types: [...Object.keys(articleNotifications).filter((type) => !type.includes('milestone'))],
  fetcher: async (notifications, { db }) => {
    const articleIds = notifications
      .map((n) => n.details.articleId as number | undefined)
      .filter(isDefined);
    if (articleIds.length === 0) return;

    const articles = await db.article.findMany({
      where: { id: { in: articleIds } },
      select: {
        id: true,
        title: true,
        user: { select: simpleUserSelect },
      },
    });

    for (const n of notifications) {
      const article = articles.find((c) => c.id === n.details.articleId);
      if (article) {
        n.details.actor = article.user;
      }
    }
  },
});
