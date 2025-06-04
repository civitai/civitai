import { Prisma } from '@prisma/client';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { ArticleStatus, Availability } from '~/shared/utils/prisma/enums';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
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
    'createdAt',
    'stats.commentCount',
    'stats.favoriteCount',
    'stats.collectedCount',
    'stats.viewCount',
    'stats.tippedAmountCount',
    'id',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  const filterableAttributes = ['tags.name', 'user.username', 'nsfwLevel'];

  if (
    // Meilisearch stores sorted.
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

const transformData = async ({
  articles,
  cosmetics,
}: {
  articles: Article[];
  cosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
}) => {
  const records = articles
    .map(({ tags, stats, ...articleRecord }) => {
      const coverImage = articleRecord.coverImage;
      if (!coverImage) return null;
      return {
        ...articleRecord,
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
          // !important - when article `userNsfwLevel` equals article `nsfwLevel`, it's possible that the article `userNsfwLevel` is higher than the cover image `nsfwLevel`. In this case, we update the image to the higher `nsfwLevel` so that it will still pass through front end filters
          nsfwLevel:
            articleRecord.nsfwLevel === articleRecord.userNsfwLevel
              ? articleRecord.nsfwLevel
              : coverImage.nsfwLevel,
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

export const articlesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
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
        publishedAt: { not: null },
        status: ArticleStatus.Published,
        tosViolation: false,
        availability: { not: Availability.Unsearchable },
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
