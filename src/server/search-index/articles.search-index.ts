import { Prisma } from '@prisma/client';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { ArticleIngestionStatus, ArticleStatus, Availability } from '~/shared/utils/prisma/enums';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { servableBanner } from '~/shared/utils/article-card-image';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { articlesFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { articlesSortableAttributes } from '~/server/search-index/sortable-attributes';
import { removeTags } from '~/utils/string-helpers';
import { removeSpoilers } from '~/utils/html-sanitize-helpers';
import { isDefined } from '~/utils/type-guards';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = ARTICLES_SEARCH_INDEX;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'title',
    'content',
    'tags.name',
    'user.username',
    'id',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    ...articlesSortableAttributes,
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  if (
    // Meilisearch stores sorted.
    JSON.stringify(articlesFilterableAttributes.sort()) !==
    JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      articlesFilterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

export const transformData = async ({
  articles,
  cosmetics,
}: {
  articles: Article[];
  cosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
}) => {
  const records = articles
    .map(({ tags, stats, bannerImage, ...articleRecord }) => {
      // A banner stands in for a missing cover on the card, once it is servable.
      const coverImage = articleRecord.coverImage ?? servableBanner(bannerImage);
      if (!coverImage) return null;
      return {
        ...articleRecord,
        // `content` is a searchable attribute and is stored as HTML, so tag and
        // attribute names were indexed as prose — a query for `iframe` could
        // match on markup. Regex-strip rather than a full HTML-to-text pass:
        // this runs over every article on a reindex. Spoilers are dropped first so
        // a search hit cannot show them; only bodies naming "spoiler" pay a parse.
        content: removeTags(removeSpoilers(articleRecord.content)),
        nsfwLevel: parseBitwiseBrowsingLevel(articleRecord.nsfwLevel),
        stats: stats
          ? {
              favoriteCount: stats.favoriteCountAllTime,
              collectedCount: stats.collectedCountAllTime,
              commentCount: stats.commentCountAllTime,
              likeCount: stats.likeCountAllTime,
              dislikeCount: stats.dislikeCountAllTime,
              heartCount: stats.heartCountAllTime,
              laughCount: stats.laughCountAllTime,
              cryCount: stats.cryCountAllTime,
              viewCount: stats.viewCountAllTime,
              tippedAmountCount: stats.tippedAmountCountAllTime,
            }
          : undefined,
        // Flatten tags:
        tags: tags.map((articleTag) => articleTag.tag),
        coverImage: {
          ...coverImage,
          // Lift the cover image nsfwLevel to the article's aggregate so
          // front-end filters (ImageGuard blur, browsingLevel mask) reflect
          // the article's true rating whenever content images, userNsfwLevel,
          // or the moderation floor raised it above the cover's own level.
          nsfwLevel: Math.max(articleRecord.nsfwLevel ?? 0, coverImage.nsfwLevel ?? 0),
          meta: coverImage.meta as ImageMetaProps,
          tags: coverImage.tags.map((x) => x.tag),
        },
        cosmetic: cosmetics[articleRecord.id] ?? null,
      };
    })
    .filter(isDefined);

  return records;
};

export type ArticleSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

const articleSelect = {
  ...articleDetailSelect,
  bannerImage: articleDetailSelect.coverImage,
  stats: {
    select: {
      favoriteCountAllTime: true,
      collectedCountAllTime: true,
      commentCountAllTime: true,
      likeCountAllTime: true,
      dislikeCountAllTime: true,
      heartCountAllTime: true,
      laughCountAllTime: true,
      cryCountAllTime: true,
      viewCountAllTime: true,
      tippedAmountCountAllTime: true,
    },
  },
};

type Article = Prisma.ArticleGetPayload<{
  select: typeof articleSelect;
}>;

/** The articles the index holds. The semantic search sync copies it; a parity test pins the copy. */
export const articleSearchEligibleWhere = {
  publishedAt: { not: null },
  status: ArticleStatus.Published,
  ingestion: ArticleIngestionStatus.Scanned,
  tosViolation: false,
  availability: { not: Availability.Unsearchable },
} satisfies Prisma.ArticleWhereInput;

/**
 * Which articles the semantic search may return: the Meilisearch rule, minus unlisted articles and
 * those whose owner is banned. The event-engine's ARTICLE_ELIGIBLE_SQL is its copy, held to it by
 * article-eligibility.parity.test.ts.
 */
export const articleSemanticEligibleWhere = {
  ...articleSearchEligibleWhere,
  unlisted: false,
  user: { bannedAt: null },
} satisfies Prisma.ArticleWhereInput;

export const articlesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  outboxEntity: 'Article',
  setup: onIndexSetup,
  prepareBatches: async ({ db }, lastUpdatedAt) => {
    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Article"
      ${
        lastUpdatedAt
          ? Prisma.sql`
        WHERE "createdAt" >= ${lastUpdatedAt}
      `
          : Prisma.sql``
      };
    `;

    const { startId, endId } = data[0];

    return {
      batchSize: 1000,
      startId,
      endId,
    };
  },
  pullData: async ({ db, logger }, batch) => {
    logger(`PullData :: Pulling data for batch: ${batch}`);
    const articles = await db.article.findMany({
      select: articleSelect,
      where: {
        ...articleSearchEligibleWhere,
        id: batch.type === 'update' ? { in: batch.ids } : { gte: batch.startId, lte: batch.endId },
      },
    });

    logger(`PullData :: Pulled articles`);

    const cosmetics = await getCosmeticsForEntity({
      ids: articles.map((x) => x.id),
      entity: 'Article',
    });

    logger(`PullData :: Pulled cosmetics`);

    return {
      articles,
      cosmetics,
    };
  },
  transformData,
  pushData: async ({ indexName }, records) => {
    await updateDocs({
      indexName,
      documents: records as any[],
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    return;
  },
});
