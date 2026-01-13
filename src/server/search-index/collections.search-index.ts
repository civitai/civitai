import { Prisma } from '@prisma/client';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import type {
  CollectionMode,
  CollectionType,
  CollectionWriteConfiguration,
  CosmeticSource,
  CosmeticType,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { uniqBy } from 'lodash-es';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';

const READ_BATCH_SIZE = 1000; // 10 items per collection are fetched for images. Careful with this number
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = COLLECTIONS_SEARCH_INDEX;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['name'];

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
    'metrics.itemCount',
    'metrics.followerCount',
    'metrics.contributorCount',
  ];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'attribute', 'words', 'proximity', 'exactness'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  const filterableAttributes = ['user.username', 'type', 'nsfwLevel', 'id'];

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
  postId: number | null;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  meta: Prisma.JsonObject | null;
  userId: number;
} | null;

type CollectionForSearchIndex = {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  type: CollectionType;
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
  userId: number;
  mode: CollectionMode | null;
  nsfwLevel: number;
  metrics: {
    followerCount: number;
    itemCount: number;
    contributorCount: number;
  };
  user: {
    id: number;
    image: string | null;
    username: string | null;
    deletedAt: Date | null;
    profilePictureId: number | null;
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
  image: ImageProps;
};

type CollectionImageRaw = {
  id: number;
  image: ImageProps | null;
  src: string | null;
};

const parseImageMeta = (meta: ImageMetaProps) => {
  const parsed = imageGenerationSchema.omit({ comfy: true }).partial().safeParse(meta);
  return parsed?.success ? parsed.data : {};
};

const WHERE = [
  Prisma.sql`c."userId" != -1`,
  Prisma.sql`c.read = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"`,
  // Don't index empty collections:
  Prisma.sql`EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)`,
  Prisma.sql`c."availability" != 'Unsearchable'::"Availability"`,
];

const transformData = async ({
  collections,
  itemImages,
  tags,
  profilePictures,
}: {
  collections: CollectionForSearchIndex[];
  itemImages: CollectionImageRaw[];
  tags: { imageId: number; tagId: number }[];
  profilePictures: ProfileImage[];
}) => {
  const records = collections
    .map(({ cosmetics, user, image, ...collection }) => {
      const collectionImage = image
        ? {
            ...image,
            meta: parseImageMeta(image.meta as ImageMetaProps),
            tags: tags.filter((t) => t.imageId === image.id).map((t) => ({ id: t.tagId })),
          }
        : null;
      const collectionImages = itemImages.filter((i) => i.id === collection.id);
      const images = collectionImages
        .map((i) => i.image)
        .filter(isDefined)
        .map((i) => ({
          ...i,
          meta: parseImageMeta(i.meta as ImageMetaProps),
          tags: tags.filter((t) => t.imageId === i.id).map((t) => ({ id: t.tagId })),
        }));
      const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;

      return {
        ...collection,
        nsfwLevel: parseBitwiseBrowsingLevel(collection.nsfwLevel),
        image: collectionImage,
        metrics: collection.metrics || {},
        user: {
          ...user,
          cosmetics: cosmetics ?? [],
          profilePicture,
        },
        images: uniqBy(images, 'id') ?? [],
        srcs: [...new Set(collectionImages.map((i) => i.src).filter(isDefined) ?? [])],
      };
    })
    .filter(isDefined);

  return records;
};

export type CollectionSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const collectionsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
    const where = [
      ...WHERE,
      lastUpdatedAt ? Prisma.sql`c."createdAt" >= ${lastUpdatedAt}` : undefined,
    ].filter(isDefined);

    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Collection" c
      WHERE ${Prisma.join(where, ' AND ')}
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
  },
  pullData: async ({ db, logger }, batch, step) => {
    logger(`PullData :: Pulling data for batch: ${batch}`);
    const where = [
      ...WHERE,
      batch.type === 'update' ? Prisma.sql`c.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`c.id >= ${batch.startId} AND c.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    const imageSql = Prisma.sql`
    jsonb_build_object(
        'id', i."id",
        'index', i."index",
        'postId', i."postId",
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
        'userId', i."userId",
        'meta', i."meta"
      ) image
  `;

    // When metrics are ready use this one :D
    const collections = await db.$queryRaw<CollectionForSearchIndex[]>`
    WITH target AS MATERIALIZED (
      SELECT
      c.id,
      c.name,
      c."imageId",
      c."createdAt",
      c."updatedAt",
      c."userId",
      c."type",
      c."read",
      c."write",
      c."mode",
      c."nsfwLevel"
      FROM "Collection" c
      WHERE ${Prisma.join(where, ' AND ')}
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
        i.id,
        ${imageSql}
      FROM "Image" i
      WHERE i.id IN (SELECT "imageId" FROM target)
        AND i."ingestion" = 'Scanned'
        AND i."needsReview" IS NULL
      GROUP BY i.id
    ), metrics as MATERIALIZED (
      SELECT
        cm."collectionId",
        jsonb_build_object(
          'followerCount', cm."followerCount",
          'itemCount', cm."itemCount",
          'contributorCount', cm."contributorCount"
        ) metrics
      FROM "CollectionMetric" cm
      WHERE cm.timeframe = 'AllTime'
        AND cm."collectionId" IN (SELECT id FROM target)
    )
    SELECT
      t.*,
      (SELECT metrics FROM metrics m WHERE m."collectionId" = t.id),
      (SELECT "image" FROM images i WHERE i.id = t."imageId"),
      (SELECT "user" FROM users u WHERE u.id = t."userId"),
      (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
    FROM target t
    `;

    logger(`PullData :: collections data pulled`);
    // Avoids hitting the DB without data.
    if (collections.length === 0) {
      logger(`PullData :: no collections found in batch`);
      return [];
    }

    const collectionsNeedingImages = collections.filter((c) => !c.image).map((c) => c.id);
    let itemImages: CollectionImageRaw[] = [];

    if (collectionsNeedingImages.length > 0) {
      itemImages = await db.$queryRaw<CollectionImageRaw[]>`
      WITH target AS MATERIALIZED (
        SELECT *
        FROM (
          SELECT *,
          ROW_NUMBER() OVER (
              PARTITION BY ci."collectionId"
              ORDER BY ci.id
            ) AS idx
          FROM "CollectionItem" ci
          WHERE ci.status = 'ACCEPTED'
            AND ci."collectionId" IN (${Prisma.join(collectionsNeedingImages)})
        ) t
        WHERE idx <= 10
      ), imageItemImage AS MATERIALIZED (
        SELECT
          i.id,
          ${imageSql}
        FROM "Image" i
        WHERE i.id IN (SELECT "imageId" FROM target WHERE "imageId" IS NOT NULL)
          AND i."ingestion" = 'Scanned'
          AND i."needsReview" IS NULL
      ), postItemImage AS MATERIALIZED (
        SELECT * FROM (
            SELECT
              i."postId" id,
              ${imageSql},
              ROW_NUMBER() OVER (PARTITION BY i."postId" ORDER BY i.index) rn
            FROM "Image" i
            WHERE i."postId" IN (SELECT "postId" FROM target WHERE "postId" IS NOT NULL)
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
        ) t
        WHERE t.rn = 1
      ), modelItemImage AS MATERIALIZED (
        SELECT * FROM (
            SELECT
              m.id,
              ${imageSql},
              ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) rn
            FROM "Image" i
            JOIN "Post" p ON p.id = i."postId"
            JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
            JOIN "Model" m ON mv."modelId" = m.id AND m."userId" = p."userId"
            WHERE m."id" IN (SELECT "modelId" FROM target WHERE "modelId" IS NOT NULL)
                AND i."ingestion" = 'Scanned'
                AND i."needsReview" IS NULL
        ) t
        WHERE t.rn = 1
      ), articleItemImage as MATERIALIZED (
          SELECT a.id, a.cover image FROM "Article" a
          WHERE a.id IN (SELECT "articleId" FROM target)
      )
      SELECT
          target."collectionId" id,
          COALESCE(
            (SELECT image FROM imageItemImage iii WHERE iii.id = target."imageId"),
            (SELECT image FROM postItemImage pii WHERE pii.id = target."postId"),
            (SELECT image FROM modelItemImage mii WHERE mii.id = target."modelId"),
            NULL
          ) image,
          (SELECT image FROM articleItemImage aii WHERE aii.id = target."articleId") src
      FROM target
    `;
    }

    const collectionImages = collections.map((c) => c.image?.id).filter(isDefined);
    const imageIds = [
      ...collectionImages,
      ...new Set(itemImages.map(({ image }) => image?.id).filter(isDefined)),
    ];

    logger(`PullData :: Pulled collection images.`);

    // Use Redis cache for tag lookups (much faster than direct DB query)
    const imageTagsCache = await tagIdsForImagesCache.fetch(imageIds);
    const tags = Object.entries(imageTagsCache).flatMap(([imageId, cache]) =>
      cache.tags.map((tagId) => ({ imageId: +imageId, tagId }))
    );

    const profilePictures = await db.image.findMany({
      where: { id: { in: collections.map((c) => c.user.profilePictureId).filter(isDefined) } },
      select: profileImageSelect,
    });

    logger(`PullData :: Pulled tags & profile pics.`);

    return {
      collections,
      itemImages,
      tags,
      profilePictures,
    };
  },
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
