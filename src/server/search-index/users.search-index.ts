import { Prisma } from '@prisma/client';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { usersFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { updateDocs } from '~/server/meilisearch/client';

import { getOrCreateIndex } from '~/server/meilisearch/util';
import type {
  SearchIndexContext,
  SearchIndexPullBatch,
} from '~/server/search-index/base.search-index';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { USER_SEARCH_INDEX_ELIGIBILITY } from '~/server/search-index/user-index-eligibility';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';

import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 15000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 15000;
const INDEX_ID = USERS_SEARCH_INDEX;

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
    'id',
    'metrics.thumbsUpCount',
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

  if (
    // Meilisearch stores sorted.
    JSON.stringify(usersFilterableAttributes.sort()) !==
    JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      usersFilterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

type BaseUser = {
  id: number;
  username: string | null;
  createdAt: Date;
  image: string | null;
  deletedAt: Date | null;
};
type UserMetric = {
  userId: number;
  followerCount: number;
  uploadCount: number;
  thumbsUpCount: number;
  downloadCount: number;
};
type UserRank = {
  userId: number;
  leaderboardRank: number;
  leaderboardId: string;
  leaderboardTitle: string;
  leaderboardCosmetic: string;
};

/**
 * The WHERE every read in this index is built from: the eligibility predicate shared with the
 * nightly reconciler (`~/server/meilisearch/cleanup.ts`), plus whatever clause narrows this
 * particular batch. Narrowing clauses come AFTER, so eligibility can never be dropped by one.
 *
 * 🔴 A FUNCTION, AND THE ONLY NAME FOR THIS. It was previously an exported constant with a local
 * alias beside it, and the alias — not the constant — was what the queries consumed. A test
 * pinning the constant therefore said nothing about the queries: re-binding the alias to a
 * two-element copy dropped `bannedAt IS NULL` from every write-side query with the whole suite
 * green. One name removes the gap, and the tests now pin the SQL that reaches `$queryRaw`
 * rather than anything declared here.
 */
export const buildUsersIndexWhere = (...narrowing: (Prisma.Sql | undefined)[]) =>
  [...USER_SEARCH_INDEX_ELIGIBILITY, ...narrowing].filter(isDefined);

const transformData = async ({
  users,
  metrics,
  ranks,
  profilePictures,
  cosmetics,
}: {
  users: BaseUser[];
  metrics: UserMetric[];
  ranks: UserRank[];
  profilePictures: Awaited<ReturnType<typeof getProfilePicturesForUsers>>;
  cosmetics: Awaited<ReturnType<typeof getCosmeticsForUsers>>;
}) => {
  const records = users.map((user) => {
    return {
      ...user,
      profilePicture: profilePictures[user.id] ?? null,
      rank: ranks.find((r) => r.userId === user.id),
      metrics: metrics.find((m) => m.userId === user.id),
      cosmetics: cosmetics[user.id] ?? [],
    };
  });

  return records;
};

export type UserSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

/**
 * Hoisted out of the processor config and exported so a test can drive it and read the SQL it
 * actually issues. Pinning a constant these functions are *supposed* to use is one indirection
 * short of pinning what they do — and that indirection is exactly what an adversarial round
 * walked through.
 */
export const prepareUsersBatches = async (
  { db, logger }: SearchIndexContext,
  lastUpdatedAt?: Date
) => {
  const where = buildUsersIndexWhere(
    lastUpdatedAt ? Prisma.sql`u."createdAt" >= ${lastUpdatedAt}` : undefined
  );

  const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT
        (
          SELECT u.id
          FROM "User" u
          WHERE ${Prisma.join(where, ' AND ')}
          ORDER BY "createdAt" ASC
          LIMIT 1
        ) as "startId",
        (
          SELECT u.id
          FROM "User" u
          WHERE ${Prisma.join(where, ' AND ')}
          ORDER BY "createdAt" DESC
          LIMIT 1
        ) as "endId"
    `;

  const { startId, endId } = data[0];

  logger(
    `PrepareBatches :: Prepared batch: ${startId} - ${endId} ... Last updated: ${lastUpdatedAt}`
  );

  return {
    batchSize: READ_BATCH_SIZE,
    startId,
    endId,
  };
};

/** Hoisted and exported for the same reason as {@link prepareUsersBatches}. */
export const pullUsersData = async (
  { db, logger }: SearchIndexContext,
  batch: SearchIndexPullBatch,
  step?: number,
  prevData?: any
) => {
  {
    logger(
      `PullData :: Pulling data for batch`,
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
    );
    const where = buildUsersIndexWhere(
      batch.type === 'update' ? Prisma.sql`u.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`u.id >= ${batch.startId} AND u.id <= ${batch.endId}`
        : undefined
    );

    const userIds = prevData ? (prevData as { users: BaseUser[] }).users.map((u) => u.id) : [];

    // Basic info
    if (step === 0) {
      const users = await db.$queryRaw<BaseUser[]>`
        SELECT
          u.id,
          u.username,
          u."deletedAt",
          u."createdAt",
          u.image
        FROM "User" u
        WHERE ${Prisma.join(where, ' AND ')}
      `;

      if (!users.length) return null;

      return {
        users,
      };
    }

    // Metrics
    if (step === 1) {
      // What we can get from user metrics
      const metrics = await db.$queryRaw<UserMetric[]>`
        SELECT
          um."userId",
          um."followerCount",
          um."uploadCount"
        FROM "UserMetric" um
        WHERE um."userId" IN (${Prisma.join(userIds)})
          AND um."timeframe" = 'AllTime'::"MetricTimeframe"
      `;

      // What we can get from model metrics
      const modelMetrics = await db.$queryRaw<UserMetric[]>`
        SELECT
          mm."userId",
          SUM(mm."thumbsUpCount") AS "thumbsUpCount",
          SUM(mm."downloadCount") AS "downloadCount"
        FROM "ModelMetric" mm
        WHERE mm."userId" IN (${Prisma.join(userIds)})
        GROUP BY mm."userId";
      `;
      // Not using stats because it hits other unnecessary tables

      // Merge in model metrics
      const modelMetricsMap = Object.fromEntries(modelMetrics.map((m) => [m.userId, m]));
      for (const metric of metrics) {
        const modelMetric = modelMetricsMap[metric.userId];
        metric.thumbsUpCount = Number(modelMetric?.thumbsUpCount ?? 0);
        metric.downloadCount = Number(modelMetric?.downloadCount ?? 0);
      }

      return {
        ...prevData,
        metrics,
      };
    }

    // Ranks
    if (step === 2) {
      const ranks = await db.$queryRaw<UserRank[]>`
        SELECT
          ur."userId",
          ur."leaderboardRank",
          ur."leaderboardId",
          ur."leaderboardTitle",
          ur."leaderboardCosmetic"
        FROM "UserRank" ur
        WHERE ur."userId" IN (${Prisma.join(userIds)})
          AND ur."leaderboardRank" IS NOT NULL
      `;

      return {
        ...prevData,
        ranks,
      };
    }

    // Profile pictures & cosmetics
    if (step === 3) {
      const profilePictures = await getProfilePicturesForUsers(userIds);
      const cosmetics = await getCosmeticsForUsers(userIds);

      return {
        ...prevData,
        profilePictures,
        cosmetics,
      };
    }

    return prevData;
  }
};

export const usersSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  workerCount: 25,
  prepareBatches: prepareUsersBatches,
  pullSteps: 4,
  pullData: pullUsersData,
  transformData,
  pushData: async ({ indexName, jobContext }, records) => {
    await updateDocs({
      indexName,
      documents: records as any[],
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    return;
  },
});
