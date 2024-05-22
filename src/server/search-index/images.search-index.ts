import { client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import {
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  Prisma,
} from '@prisma/client';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { ImageModelWithIngestion, profileImageSelect } from '../selectors/image.selector';
import { isDefined } from '~/utils/type-guards';
import { NsfwLevel } from '~/server/common/enums';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { getCosmeticsForUsers } from '~/server/services/user.service';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = IMAGES_SEARCH_INDEX;

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

  const searchableAttributes: SearchableAttributes = [
    'meta.prompt',
    'generationProcess',
    'tagNames',
    'user.username',
  ];

  const sortableAttributes: SortableAttributes = [
    'createdAt',
    'stats.commentCountAllTime',
    'stats.reactionCountAllTime',
    'stats.collectedCountAllTime',
    'stats.tippedAmountCountAllTime',
  ];

  const filterableAttributes: FilterableAttributes = [
    'createdAtUnix',
    'tagNames',
    'user.username',
    'baseModel',
    'generationTool',
    'aspectRatio',
    'nsfwLevel',
    'type',
  ];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );

    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);

    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  if (
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

type ImageForSearchIndex = {
  type: MediaType;
  id: number;
  generationProcess: ImageGenerationProcess | null;
  createdAt: Date;
  name: string | null;
  url: string;
  meta: Prisma.JsonValue;
  hash: string | null;
  height: number | null;
  width: number | null;
  metadata: Prisma.JsonValue;
  nsfwLevel: NsfwLevel;
  postId: number | null;
  needsReview: string | null;
  hideMeta: boolean;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  modelVersionId: number | null;
  baseModel?: string | null;
  userId?: number | null;
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
  tagNames: string[];
  tagIds: number[];
  stats: {
    cryCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    likeCountAllTime: number;
    reactionCountAllTime: number;
    commentCountAllTime: number;
    collectedCountAllTime: number;
    tippedAmountCountAllTime: number;
  } | null;
};

const imageWhere = [
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."type" = 'image'`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
  Prisma.sql`p."availability" != 'Unsearchable'::"Availability"`,
];

type ProfileImage = Prisma.ImageGetPayload<{
  select: typeof profileImageSelect;
}>;

type ImageTag = {
  imageId: number;
  tagId: number;
  tagName: string;
};

type User = {
  id: number;
  username?: string | null;
  deletedAt?: Date | null;
  image?: string | null;
  profilePictureId?: number | null;
};

const transformData = async ({
  users,
  images,
  rawTags,
  userCosmetics,
  imageCosmetics,
  profilePictures,
}: {
  images: ImageForSearchIndex[];
  rawTags: ImageTag[];
  imageCosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
  profilePictures: ProfileImage[];
  users: User[];
  userCosmetics: Awaited<ReturnType<typeof getCosmeticsForUsers>>;
}) => {
  const records = images
    .map(({ meta, userId, ...imageRecord }) => {
      const user = userId ? users.find((u) => u.id === userId) ?? null : null;

      if (!user) {
        return null;
      }

      const userCosmetic = userId ? userCosmetics[userId] ?? null : null;

      const parsed = imageGenerationSchema
        .omit({ comfy: true, hashes: true })
        .partial()
        .safeParse(meta);
      const tags = rawTags
        .filter((rt) => rt.imageId === imageRecord.id)
        .map((rt) => ({ id: rt.tagId, name: rt.tagName }));
      const profilePicture = user
        ? profilePictures.find((p) => p.id === user.profilePictureId) ?? null
        : null;

      return {
        ...imageRecord,
        nsfwLevel: parseBitwiseBrowsingLevel(imageRecord.nsfwLevel),
        createdAtUnix: imageRecord.createdAt.getTime(),
        aspectRatio:
          !imageRecord.width || !imageRecord.height
            ? 'Unknown'
            : imageRecord.width > imageRecord.height
            ? 'Landscape'
            : imageRecord.width < imageRecord.height
            ? 'Portrait'
            : 'Square',
        generationTool: meta?.hasOwnProperty('comfy')
          ? 'Comfy'
          : meta?.hasOwnProperty('prompt')
          ? 'Automatic1111'
          : 'Unknown',
        meta: parsed.success ? parsed.data : {},
        user: {
          ...user,
          cosmetics: userCosmetic ?? [],
          profilePicture,
        },
        tagNames: tags.map((t) => t.name),
        tagIds: tags.map((t) => t.id),
        reactions: [],
        cosmetic: imageCosmetics[imageRecord.id] ?? null,
      };
    })
    .filter(isDefined);

  return records;
};

export type ImageSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const imagesSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  pullSteps: 3,
  prepareBatches: async ({ db }, lastUpdatedAt) => {
    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
    SELECT (	
      SELECT
      i.id FROM "Image" i 
      ${
        lastUpdatedAt
          ? Prisma.sql`
        WHERE i."createdAt" >= ${lastUpdatedAt} 
      `
          : Prisma.sql``
      }
      ORDER BY "createdAt" LIMIT 1
    ) as "startId", (	
      SELECT MAX (id) FROM "Image"
    ) as "endId";      
    `;

    const { startId, endId } = data[0];

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
    };
  },
  pullData: async ({ db, logger }, batch, step, prevData) => {
    logger(`PullData :: Pulling data for batch: ${batch}`);
    const where = [
      ...imageWhere,

      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`i.id >= ${batch.startId} AND i.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    if (step === 0) {
      const images = await db.$queryRaw<ImageForSearchIndex[]>`
      WITH target AS MATERIALIZED (
        SELECT
        i."id",
        i."index",
        i."postId",
        i."name",
        i."url",
        i."nsfwLevel",
        i."width",
        i."height",
        i."hash",
        jsonb_build_object(
          'prompt', i."meta"->'prompt'
        ) "meta",
        i."hideMeta",
        i."generationProcess",
        i."createdAt",
        i."mimeType",
        i."scannedAt",
        i."type",
        i."metadata",
        i."userId",
        p."modelVersionId",
        (
          SELECT mv."baseModel" FROM "ModelVersion" mv
          RIGHT JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
          JOIN "Model" m ON mv."modelId" = m.id
          WHERE m."type" = 'Checkpoint'
          LIMIT 1
        ) "baseModel"
          FROM "Image" i
          JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
          WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY i."id"
      ), stats AS MATERIALIZED (
          SELECT
            im."imageId",
            jsonb_build_object(
              'commentCountAllTime', SUM("commentCount"),
              'laughCountAllTime', SUM("laughCount"),
              'heartCountAllTime', SUM("heartCount"),
              'dislikeCountAllTime', SUM("dislikeCount"),
              'likeCountAllTime', SUM("likeCount"),
              'cryCountAllTime', SUM("cryCount"),
              'reactionCountAllTime', SUM("reactionCount"),
              'collectedCountAllTime', SUM("collectedCount"),
              'tippedAmountCountAllTime', SUM("tippedAmountCount")
            ) stats
          FROM "ImageMetric" im
          WHERE im."imageId" IN (SELECT id FROM target)
            AND im."timeframe" = 'AllTime'::"MetricTimeframe"
          GROUP BY im."imageId"
      )
      SELECT
        t.*,
        (SELECT stats FROM stats s WHERE s."imageId" = t.id)
      FROM target t
    `;
      if (images.length === 0) {
        return null;
      }

      return {
        images,
      };
    }

    if (step === 1) {
      // Pull tags:
      const { images } = prevData as { images: ImageForSearchIndex[] };

      const rawTags = await db.imageTag.findMany({
        where: { imageId: { in: images.map((i) => i.id) }, concrete: true },
        select: {
          imageId: true,
          tagId: true,
          tagName: true,
        },
      });

      // Also, queue model updates:
      if (batch.type === 'update') {
        const affectedModels = await db.$queryRaw<{ modelId: number }[]>`
          SELECT
            m.id "modelId"
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId" AND p."modelVersionId" IS NOT NULL AND p."publishedAt" IS NOT NULL
          JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
          JOIN "Model" m ON m.id = mv."modelId" AND i."userId" = m."userId"
          WHERE i.id IN (${Prisma.join(images.map(({ id }) => id))})
        `;

        const affectedModelIds = [...new Set(affectedModels.map(({ modelId }) => modelId))];

        await modelsSearchIndex.queueUpdate(
          affectedModelIds.map((id) => ({
            id: id,
            action: SearchIndexUpdateQueueAction.Update,
          }))
        );
      }

      return {
        images,
        rawTags,
      };
    }

    if (step === 2) {
      const { images, rawTags } = prevData as {
        images: ImageForSearchIndex[];
        rawTags: ImageTag[];
      };

      const users = await db.user.findMany({
        select: {
          id: true,
          username: true,
          deletedAt: true,
          image: true,
          profilePictureId: true,
        },
        where: {
          id: { in: images.map((i) => i.userId).filter(isDefined) },
        },
      });

      const profilePictures = await db.image.findMany({
        where: { id: { in: users.map((u) => u.profilePictureId).filter(isDefined) } },
        select: profileImageSelect,
      });

      const cosmetics = await getCosmeticsForEntity({
        ids: images.map((i) => i.id),
        entity: 'Image',
      });

      const userCosmetics = await getCosmeticsForUsers([
        ...new Set<number>(images.map((i) => i.userId).filter(isDefined)),
      ]);

      return {
        images,
        rawTags,
        profilePictures,
        imageCosmetics: cosmetics,
        userCosmetics,
        users,
      };
    }

    return null;
  },
  transformData,
  pushData: async ({ indexName }, data) => {
    if (data.length > 0) {
      await updateDocs({
        indexName,
        documents: data,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      });
    }

    return;
  },
});
