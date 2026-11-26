import {
  getReportListedHiddenImageIds,
  SIGNED_OUT_REPORT_LISTED,
} from '~/server/services/report-listed-visibility';
import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  hasBlockMarker,
  isMinorMatureImage,
  withoutMinorFlag,
} from '~/server/common/image-visibility';
import { articleSemanticEligibleWhere } from '~/server/search-index/articles.search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import { getModelWithheldImageIds } from '~/server/services/collection-cover-visibility';
import { getCategoryTags } from '~/server/services/system-cache';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';
import { servableArticleImage } from '~/shared/utils/article-card-image';

// The article must be one anyone may read. Not its scan state: publishedAt is set once the scan is
// done, and an article left out of its publish window is never sent.
const { ingestion: _ingestion, ...publicArticleWhere } = articleSemanticEligibleWhere;

const baseUrl = getBaseUrl();
export const articleWebhooks = createWebhookProcessor({
  'new-article': {
    displayName: 'New Articles',
    getData: async ({ lastSent, prisma }) => {
      const now = new Date();
      const articles = await prisma.article.findMany({
        where: {
          ...publicArticleWhere,
          publishedAt: {
            gt: lastSent,
            lte: now,
          },
        },
        select: { ...articleDetailSelect, coverImage: { select: { ...imageSelect, minor: true } } },
      });
      if (!articles.length) return [];

      // The cover goes out only as a signed-out viewer would see it.
      const coverIds = articles
        .map((article) => article.coverImage?.id)
        .filter((id): id is number => !!id);
      const [withheld, listed] = await Promise.all([
        getModelWithheldImageIds(coverIds, prisma),
        getReportListedHiddenImageIds(coverIds, SIGNED_OUT_REPORT_LISTED, prisma),
      ]);
      const publicCover = (image: (typeof articles)[number]['coverImage']) =>
        image &&
        !hasBlockMarker(image) &&
        !withheld.has(image.id) &&
        !listed.has(image.id) &&
        !isMinorMatureImage(image)
          ? servableArticleImage(image)
          : null;

      const articleCategories = await getCategoryTags('article');
      return articles.map(({ cover, coverImage, user, tags: allTags, ...article }) => {
        const shownCover = publicCover(coverImage);
        // `cover` is the same image's key; a legacy article without a cover image keeps it.
        const coverAllowed = !coverImage || !!shownCover;
        const categories: string[] = [];
        const tags: string[] = [];
        for (const { tag } of allTags) {
          if (articleCategories.some((c) => c.id === tag.id)) categories.push(tag.name);
          else tags.push(tag.name);
        }

        return {
          ...article,
          coverImage: shownCover && withoutMinorFlag(shownCover),
          type: categories[0] ?? 'article',
          tags,
          cover: coverAllowed && cover ? getEdgeUrl(cover, { width: 450 }) : null,
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
