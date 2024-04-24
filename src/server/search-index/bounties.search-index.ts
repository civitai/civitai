import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import {
  BountyType,
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  MediaType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { dbRead } from '~/server/db/client';
import { ImageMetadata } from '~/server/schema/media.schema';
import { ImageModelWithIngestion, profileImageSelect } from '../selectors/image.selector';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

const READ_BATCH_SIZE = 250; // 10 items per bounty are fetched for images. Careful with this number
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = BOUNTIES_SEARCH_INDEX;
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['name', 'user.username'];

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
    'stats.unitAmountCountAllTime',
    'stats.entryCountAllTime',
    'stats.favoriteCountAllTime',
  ];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'attribute', 'words', 'proximity', 'exactness', 'typo'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  const filterableAttributes = [
    'user.username',
    'type',
    'details.baseModel',
    'tags.name',
    'complete',
    'nsfwLevel',
  ];

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

export type BountySearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];

type ImageProps = {
  type: MediaType;
  id: number;
  createdAt: Date;
  name: string | null;
  url: string;
  hash: string | null;
  height: number | null;
  width: number | null;
  nsfwLevel: number;
  userId: number;
  postId: number | null;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  meta: Prisma.JsonObject | null;
  generationProcess: ImageGenerationProcess;
  needsReview: string;
  metadata: ImageMetadata | null;
  entityId: number;
} | null;

type BountyForSearchIndex = {
  id: number;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  startsAt: Date;
  expiresAt: Date;
  type: BountyType;
  details: Prisma.JsonObject | null;
  complete: boolean;
  nsfwLevel: number;
  stats: {
    favoriteCountAllTime: number;
    trackCountAllTime: number;
    entryCountAllTime: number;
    benefactorCountAllTime: number;
    unitAmountCountAllTime: number;
    commentCountAllTime: number;
  } | null;
  user: {
    id: number;
    image: string | null;
    username: string | null;
    deletedAt: Date | null;
    profilePictureId: number | null;
    profilePicture: ImageModelWithIngestion | null;
  };
  cosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
  images: ImageProps[] | null;
  tags: { id: number; name: string }[] | null;
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

  const WHERE = [
    Prisma.sql`b."userId" != -1`,
    Prisma.sql`(b."startsAt" <= NOW() OR b."expiresAt" >= NOW())`,
    Prisma.sql`b."availability" != 'Unsearchable'::"Availability"`,
  ];

  if (whereOr) {
    WHERE.push(Prisma.sql`(${Prisma.join(whereOr, ' OR ')})`);
  }

  // When metrics are ready use this one :D
  const bounties = await db.$queryRaw<BountyForSearchIndex[]>`
  WITH target AS MATERIALIZED (
    SELECT
    b.id,
    b.name,
    b."nsfwLevel",
    b."description",
    b."createdAt",
    b."updatedAt",
    b."userId",
    b."startsAt",
    b."expiresAt",
    b."type",
    b."details",
    b."complete"
    FROM "Bounty" b
    WHERE ${Prisma.join(WHERE, ' AND ')}
    OFFSET ${offset} LIMIT ${READ_BATCH_SIZE}
  ), users AS MATERIALIZED (
    SELECT
      u.id,
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'deletedAt', u."deletedAt",
        'image', u.image,
        'profilePictureId', u."profilePictureId"
      ) user
    FROM "User" u
    WHERE u.id IN (SELECT "userId" FROM target)
    GROUP BY u.id
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
    WHERE uc."userId" IN (SELECT "userId" FROM target) AND uc."equippedToId" IS NULL
    GROUP BY uc."userId"
  ), images AS MATERIALIZED (
    SELECT
      ic."entityId",
      jsonb_agg(
        jsonb_build_object(
          'id', i."id",
          'index', i."index",
          'postId', i."postId",
          'userId', i."userId",
          'name', i."name",
          'url', i."url",
          'nsfwLevel', i."nsfwLevel",
          'width', i."width",
          'height', i."height",
          'hash', i."hash",
          'createdAt', i."createdAt",
          'mimeType', i."mimeType",
          'scannedAt', i."scannedAt",
          'type', i."type",
          'meta', i."meta",
          'generationProcess', i."generationProcess",
          'needsReview', i."needsReview",
          'entityId', ic."entityId"
        )
      ) images
    FROM "Image" i
    JOIN "ImageConnection" ic ON ic."imageId" = i.id AND ic."entityId" IN (SELECT "id" FROM target) AND ic."entityType" = 'Bounty'
    WHERE i."ingestion" = 'Scanned'
      AND i."needsReview" IS NULL
    GROUP BY ic."entityId"
  ), tags AS MATERIALIZED (
    SELECT
      tob."bountyId",
      jsonb_agg(
        jsonb_build_object(
          'id', t."id",
          'name', t."name"
        )
      ) tags
    FROM "Tag" t
    JOIN "TagsOnBounty" tob ON tob."tagId" = t.id AND tob."bountyId" IN (SELECT "id" FROM target)
    GROUP BY tob."bountyId"
  ), stats as MATERIALIZED (
    SELECT
      bs."bountyId",
      jsonb_build_object(
        'favoriteCountAllTime', bs."favoriteCountAllTime",
        'trackCountAllTime', bs."trackCountAllTime",
        'entryCountAllTime', bs."entryCountAllTime",
        'benefactorCountAllTime', bs."benefactorCountAllTime",
        'unitAmountCountAllTime', bs."unitAmountCountAllTime",
        'commentCountAllTime', bs."commentCountAllTime"
      ) stats
    FROM "BountyStat" bs
    WHERE bs."bountyId" IN (SELECT id FROM target)
  )
  SELECT
    t.*,
    (SELECT tags FROM tags WHERE tags."bountyId" = t.id),
    (SELECT images FROM images i WHERE i."entityId" = t.id),
    (SELECT stats FROM stats m WHERE m."bountyId" = t.id),
    (SELECT "user" FROM users u WHERE u.id = t."userId"),
    (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
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
  if (bounties.length === 0) {
    return [];
  }

  console.log(
    `onFetchItemsToIndex :: images fetching complete on ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  const imageIds = bounties
    .flatMap((b) => b.images)
    .filter(isDefined)
    .map((i) => i.id);
  const imageTags = await dbRead.tagsOnImage.findMany({
    where: { imageId: { in: imageIds }, disabled: false },
    select: { imageId: true, tagId: true, tag: { select: { name: true } } },
  });

  const profilePictures = await db.image.findMany({
    where: { id: { in: bounties.map((b) => b.user.profilePictureId).filter(isDefined) } },
    select: profileImageSelect,
  });

  console.log(
    `onFetchItemsToIndex :: tags for images fetching complete on ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  const indexReadyRecords = bounties
    .map(({ cosmetics, user, tags, images: bountyImages, nsfwLevel, ...bounty }) => {
      if (!bountyImages) {
        return null;
      }

      const images = bountyImages
        ? bountyImages.filter(isDefined).map((i) => ({
            ...i,
            tags: imageTags
              .filter((t) => t.imageId === i.id)
              .map((t) => ({ id: t.tagId, name: t.tag.name })),
          }))
        : [];
      const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;

      return {
        ...bounty,
        nsfwLevel: parseBitwiseBrowsingLevel(nsfwLevel),
        tags: tags || [],
        images,
        stats: bounty.stats || null,
        user: {
          ...user,
          cosmetics: cosmetics ?? [],
          profilePicture,
        },
      };
    })
    .filter(isDefined);

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

  const itemsToIndex: BountySearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queue.content.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [Prisma.sql`b.id IN (${Prisma.join(batch)})`],
    });

    itemsToIndex.push(...newItems);
  }

  await queue.commit();
  return itemsToIndex;
};
const onIndexUpdate = async ({ db, lastUpdatedAt, indexName }: SearchIndexRunContext) => {
  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  // await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  let offset = 0;
  const bountyTasks: EnqueuedTask[] = [];

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
      bountyTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      skip: offset,
      whereOr: !lastUpdatedAt
        ? undefined
        : [
            Prisma.sql`b."createdAt" > ${lastUpdatedAt}`,
            Prisma.sql`b."updatedAt" > ${lastUpdatedAt}`,
          ],
    });

    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    bountyTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: index update complete');
};

export const bountiesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
