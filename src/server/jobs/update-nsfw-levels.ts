import { dbRead } from '~/server/db/client';
import { createJob, getJobDate, JobContext } from './job';
import { isDefined } from '~/utils/type-guards';
import { ImageConnectionType } from '~/server/common/enums';
import { ModelStatus, Prisma } from '@prisma/client';

const imageNsfwLevelUpdateJob = createJob('update-nsfw-levels', '*/1 * * * *', async (e) => {
  // const [lastRun, setLastRun] = await getJobDate('update-nsfw-levels');
  const now = new Date();
  // TODO.nsfwLevel - work with more entity types to support tracking changes to other entities
  const updateQueue = await dbRead.nsfwLevelUpdateQueue.findMany({
    where: { createdAt: { lt: now }, entityType: 'Image' },
  });

  let postIds: number[] = [];
  let articleIds: number[] = [];
  let bountyIds: number[] = [];
  let bountyEntryIds: number[] = [];
  let collectionIds: number[] = [];
  let modelIds: number[] = [];
  let modelVersionIds: number[] = [];

  const imageIds = updateQueue.map((x) => x.entityId);
  if (!imageIds.length) return;

  // TODO.nsfwLevels - handle `deletedAt`
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      postId: true,
      connections: true,
      article: { select: { id: true } },
      collectionItems: {
        where: { imageId: { not: null } },
        select: { collectionId: true, imageId: true },
      },
    },
  });

  postIds = postIds.concat(images.map((x) => x.postId).filter(isDefined));
  articleIds = articleIds.concat(images.map((x) => x.article?.id).filter(isDefined));
  bountyIds = bountyIds.concat(
    images.flatMap((i) =>
      i.connections
        .filter((x) => x.entityType === ImageConnectionType.Bounty)
        .map((x) => x.entityId)
        .filter(isDefined)
    )
  );
  bountyEntryIds = bountyEntryIds.concat(
    images.flatMap((i) =>
      i.connections
        .filter((x) => x.entityType === ImageConnectionType.BountyEntry)
        .map((x) => x.entityId)
        .filter(isDefined)
    )
  );
  collectionIds = collectionIds.concat(
    images.flatMap((i) => i.collectionItems.map((x) => x.imageId).filter(isDefined))
  );

  if (postIds.length) {
    const modelVersions = await dbRead.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT DISTINCT ON(mv.id) mv.id
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId" AND p."publishedAt" IS NOT NULL
      WHERE mv.status = ${ModelStatus.Published}::"ModelStatus" AND p.id = ANY(ARRAY[${Prisma.join(
      postIds
    )}]::Int[])
      GROUP BY mv.id
    `);
    modelVersionIds = modelVersionIds.concat(modelVersions.map((x) => x.id));
  }

  if (modelVersionIds.length) {
    const models = await dbRead.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT DISTINCT ON (m.id) m.id
      FROM "Model" m
      JOIN "ModelVersion" mv on mv."modelId" = m.id
      WHERE mv.id = ANY(ARRAY[${Prisma.join(modelVersionIds)}]::Int[])
      GROUP BY m.id
    `);
    modelIds = modelIds.concat(models.map((x) => x.id));
  }

  const nsfwLevelChangeBatches = [
    [postIds, articleIds, bountyIds, bountyEntryIds],
    [modelVersionIds],
    [modelIds],
    [collectionIds],
  ];

  console.log({
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    collectionIds,
    modelVersionIds,
    modelIds,
  });

  console.log('end');
});

export const nsfwLevelsUpdateJobs = [imageNsfwLevelUpdateJob];
