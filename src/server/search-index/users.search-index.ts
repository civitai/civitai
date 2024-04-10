import { CosmeticSource, CosmeticType, Prisma, PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { EnqueuedTask } from 'meilisearch';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { ImageModelWithIngestion, profileImageSelect } from '~/server/selectors/image.selector';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = USERS_SEARCH_INDEX;
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const RATING_BAYESIAN_M = 3.5;
const RATING_BAYESIAN_C = 10;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['username'];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  const sortableAttributes = [
    'createdAt',
    'stats.weightedRating',
    'metrics.followerCount',
    'metrics.uploadCount',
  ];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'words', 'proximity', 'attribute', 'exactness'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  const filterableAttributes = ['id', 'username'];

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

export type UserSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];
type UserForSearchIndex = {
  id: number;
  username: string | null;
  createdAt: Date;
  image: string | null;
  deletedAt: Date | null;
  profilePictureId: number | null;
  profilePicture: ImageModelWithIngestion | null;
  metrics: {
    followerCount: number;
    uploadCount: number;
    followingCount: number;
    reviewCount: number;
    answerAcceptCount: number;
    hiddenCount: number;
    answerCount: number;
  };
  stats: {
    ratingAllTime: number;
    ratingCountAllTime: number;
    downloadCountAllTime: number;
    favoriteCountAllTime: number;
    thumbsUpCountAllTime: number;
    followerCountAllTime: number;
    answerAcceptCountAllTime: number;
    answerCountAllTime: number;
    followingCountAllTime: number;
    hiddenCountAllTime: number;
    reviewCountAllTime: number;
    uploadCountAllTime: number;
  } | null;
  rank: {
    leaderboardId: string | null;
    leaderboardRank: number | null;
    leaderboardTitle: string | null;
    leaderboardCosmetic: string | null;
  } | null;
  cosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      id: number;
      data: Prisma.JsonValue;
      type: CosmeticType;
      name: string;
      source: CosmeticSource;
    };
  }[];
};

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Sql[];
  skip?: number;
}) => {
  const offset = queryProps.skip || 0;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );

  const WHERE = [Prisma.sql`u.id != -1`, Prisma.sql`u."deletedAt" IS NULL`];

  if (whereOr) {
    WHERE.push(Prisma.sql`(${Prisma.join(whereOr, ' OR ')})`);
  }

  const users = await db.$queryRaw<UserForSearchIndex[]>`
  WITH target AS MATERIALIZED (
    SELECT
      u.id,
      u.username,
      u."deletedAt",
      u."createdAt",
      u."profilePictureId",
      u.image
    FROM "User" u
    WHERE ${Prisma.join(WHERE, ' AND ')}
    OFFSET ${offset} LIMIT ${READ_BATCH_SIZE}
  ), cosmetics AS MATERIALIZED (
    SELECT
      uc."userId",
      jsonb_agg(
        jsonb_build_object(
          'data', uc.data,
          'cosmetic', jsonb_build_object(
            'id', c.id,
            'data', c.data,
            'type', c.type,
            'source', c.source,
            'name', c.name,
            'leaderboardId', c."leaderboardId",
            'leaderboardPosition', c."leaderboardPosition"
          )
        )
      )  cosmetics
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    AND "equippedAt" IS NOT NULL
    WHERE uc."userId" IN (SELECT id FROM target) AND uc."equippedToId" IS NULL
    GROUP BY uc."userId"
  ), ranks AS MATERIALIZED (
    SELECT
      ur."userId",
      jsonb_build_object(
        'leaderboardRank', ur."leaderboardRank",
        'leaderboardId', ur."leaderboardId",
        'leaderboardTitle', ur."leaderboardTitle",
        'leaderboardCosmetic', ur."leaderboardCosmetic"
      ) rank
    FROM "UserRank" ur
    WHERE ur."leaderboardRank" IS NOT NULL
      AND ur."userId" IN (SELECT id FROM target)
  ), stats AS MATERIALIZED (
      SELECT
        m."userId",
        jsonb_build_object(
          'ratingAllTime', IIF(sum("ratingCount") IS NULL OR sum("ratingCount") < 1, 0::double precision, sum("rating" * "ratingCount")/sum("ratingCount")),
              'ratingCountAllTime', SUM("ratingCount"),
              'downloadCountAllTime', SUM("downloadCount"),
              'favoriteCountAllTime', SUM("favoriteCount"),
              'thumbsUpCountAllTime', SUM("thumbsUpCount")
        ) stats
      FROM "ModelMetric" mm
      JOIN "Model" m ON mm."modelId" = m.id AND timeframe = 'AllTime'
      WHERE m."userId" IN (SELECT id FROM target)
      GROUP BY m."userId"
  ), metrics as MATERIALIZED (
    SELECT
      um."userId",
      jsonb_build_object(
        'followerCount', um."followerCount",
        'uploadCount', um."uploadCount",
        'followingCount', um."followingCount",
        'reviewCount', um."reviewCount",
        'answerAcceptCount', um."answerAcceptCount",
        'hiddenCount', um."hiddenCount",
        'answerCount', um."answerCount"
      ) metrics
    FROM "UserMetric" um
    WHERE um.timeframe = 'AllTime'
      AND um."userId" IN (SELECT id FROM target)
  )
  SELECT
    t.*,
    (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t.id),
    (SELECT rank FROM ranks r WHERE r."userId" = t.id),
    (SELECT metrics FROM metrics m WHERE m."userId" = t.id),
    (SELECT stats FROM stats s WHERE s."userId" = t.id)
  FROM target t
  `;

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (users.length === 0) {
    return [];
  }

  const profilePictures = await db.image.findMany({
    where: { id: { in: users.map((u) => u.profilePictureId).filter(isDefined) } },
    select: profileImageSelect,
  });

  const indexReadyRecords = users.map((userRecord) => {
    const stats = userRecord.stats;
    const cosmetics = userRecord.cosmetics ?? [];
    const profilePicture =
      profilePictures.find((p) => p.id === userRecord.profilePictureId) ?? null;

    const weightedRating = !stats
      ? 0
      : (stats.ratingAllTime * stats.ratingCountAllTime + RATING_BAYESIAN_M * RATING_BAYESIAN_C) /
        (stats.ratingCountAllTime + RATING_BAYESIAN_C);

    return {
      ...userRecord,
      stats: stats
        ? {
            ...stats,
            weightedRating,
          }
        : null,
      metrics: userRecord.metrics ?? {},
      cosmetics: cosmetics ?? [],
      profilePicture,
    };
  });

  return indexReadyRecords;
};

const onUpdateQueueProcess = async ({ db, indexName }: { db: PrismaClient; indexName: string }) => {
  const queue = await SearchIndexUpdate.getQueue(indexName, SearchIndexUpdateQueueAction.Update);

  console.log(
    'onUpdateQueueProcess :: A total of ',
    queue.content.length,
    ' have been updated and will be re-indexed'
  );

  const batchCount = Math.ceil(queue.content.length / READ_BATCH_SIZE);

  const itemsToIndex: UserSearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queue.content.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [Prisma.sql`u.id IN (${Prisma.join(batch)})`],
    });

    itemsToIndex.push(...newItems);
  }

  await queue.commit();
  return itemsToIndex;
};
const onIndexUpdate = async ({
  db,
  lastUpdatedAt,
  indexName,
  updateIds,
  deleteIds,
}: SearchIndexRunContext) => {
  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  if (deleteIds && deleteIds.length > 0) {
    await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID, ids: deleteIds });
  }

  let offset = 0;
  const userTasks: EnqueuedTask[] = [];

  if (lastUpdatedAt) {
    // Only if this is an update (NOT a reset or first run) will we care for queued items:

    // Update whatever items we have on the queue.
    // Do it on batches, since it's possible that there are far more items than we expect:
    const updateTasks = await onUpdateQueueProcess({
      db,
      indexName,
    });

    if (updateTasks.length > 0) {
      const updateBaseTasks = await updateDocs({
        indexName,
        documents: updateTasks,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      });

      console.log('onIndexUpdate :: base tasks for updated items have been added');
      userTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    const whereOr: Prisma.Sql[] = [];

    if (updateIds && updateIds.length > 0) {
      whereOr.push(Prisma.sql`u.id IN (${Prisma.join(updateIds)})`);
    }

    if (lastUpdatedAt) {
      whereOr.push(Prisma.sql`u."createdAt" > ${lastUpdatedAt}`);
    }

    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      skip: offset,
      whereOr,
    });

    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    userTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: index update complete');
};

export const usersSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
