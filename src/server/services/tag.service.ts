import { ModelStatus, Prisma, TagTarget } from '@prisma/client';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { TagSort } from '~/server/common/enums';

import { dbWrite, dbRead } from '~/server/db/client';
import {
  AdjustTagsSchema,
  DeleteTagsSchema,
  GetTagsInput,
  GetVotableTagsSchema,
  ModerateTagsSchema,
} from '~/server/schema/tag.schema';
import { getSystemTags } from '~/server/services/system-cache';
import { userCache } from '~/server/services/user-cache.service';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await dbRead.$queryRaw<{ id: number; name: string; count: number }>`
    SELECT "public"."Tag"."id",
    "public"."Tag"."name",
    (
      SELECT COUNT(*) AS "_aggr_count_tagsOnModels"
      FROM "public"."TagsOnModels"
      WHERE ("public"."TagsOnModels"."modelId", "public"."TagsOnModels"."tagId") IN (
        SELECT "t0"."modelId", "t0"."tagId"
        FROM "public"."TagsOnModels" AS "t0" INNER JOIN "public"."Model" AS "j0" ON ("j0"."id") = ("t0"."modelId")
        WHERE "j0"."status" = 'Published'
          AND "t0"."modelId" IS NOT NULL
          AND "t0"."tagId" = "public"."Tag"."id"
      )
    ) as count
    FROM "public"."Tag"
    WHERE "public"."Tag"."name" LIKE ${name}
    LIMIT 1 OFFSET 0
  `;
};

export const getTags = async ({
  take,
  skip,
  entityType,
  query,
  modelId,
  not,
  unlisted = false,
  categories,
  sort,
  withModels = false,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  take?: number;
  skip?: number;
}) => {
  const AND = [Prisma.sql`t."unlisted" = ${unlisted}`];

  if (query) AND.push(Prisma.sql`t."name" LIKE ${query + '%'}`);
  if (entityType)
    AND.push(Prisma.sql`t."target" && (ARRAY[${Prisma.join(entityType)}]::"TagTarget"[])`);
  if (modelId)
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "TagsOnModels" tom WHERE tom."tagId" = t."id" AND tom."modelId" = ${modelId})`
    );
  if (not && !query) {
    AND.push(Prisma.sql`t."id" NOT IN (${Prisma.join(not)})`);
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnTags" tot
      WHERE tot."toTagId" = t."id"
      AND tot."fromTagId" IN (${Prisma.join(not)})
    )`);
  }
  if (categories) {
    const systemTags = await getSystemTags();
    const categoryTag = systemTags.find((t) => t.name === `${entityType} category`.toLowerCase());
    if (categoryTag) {
      AND.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "TagsOnTags" tot
        WHERE tot."toTagId" = t."id"
        AND tot."fromTagId" = ${categoryTag.id}
      )`);
    }
  }

  let orderBy = `t."name" ASC`;
  if (query) {
    orderBy = `LENGTH(t."name")`;
    if (entityType?.includes(TagTarget.Model)) orderBy += `, r."modelCountAllTimeRank"`;
    if (entityType?.includes(TagTarget.Image)) orderBy += `, r."imageCountAllTimeRank"`;
    if (entityType?.includes(TagTarget.Post)) orderBy += `, r."postCountAllTimeRank"`;
  } else if (sort === TagSort.MostImages) orderBy = `r."imageCountAllTimeRank"`;
  else if (sort === TagSort.MostModels) orderBy = `r."modelCountAllTimeRank"`;
  else if (sort === TagSort.MostPosts) orderBy = `r."postCountAllTimeRank"`;

  const tagsRaw = await dbRead.$queryRaw<{ id: number; name: string }[]>`
    SELECT
      t."id",
      t."name"
    FROM "Tag" t
    ${Prisma.raw(orderBy.includes('r.') ? `JOIN "TagRank" r ON r."tagId" = t."id"` : '')}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${take} OFFSET ${skip}
  `;

  const models: Record<number, number[]> = {};
  if (withModels) {
    const modelTags = await dbRead.tagsOnModels.findMany({
      where: { tagId: { in: tagsRaw.map((t) => t.id) } },
      select: { tagId: true, modelId: true },
    });
    for (const { tagId, modelId } of modelTags) {
      if (!models[tagId]) models[tagId] = [];
      models[tagId].push(modelId);
    }
  }

  const items = tagsRaw.map((t) => ({
    ...t,
    models: withModels ? models[t.id] ?? [] : undefined,
  }));
  const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int count FROM "Tag" t
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  return { items, count };
};

// #region [tag voting]

export const getVotableTags = async ({
  userId,
  type,
  id,
  take = 20,
}: GetVotableTagsSchema & { userId?: number }) => {
  const results: VotableTagModel[] = [];
  if (type === 'model') {
    const tags = await dbRead.modelTag.findMany({
      where: { modelId: id, score: { gt: 0 } },
      select: {
        tagId: true,
        tagName: true,
        tagType: true,
        score: true,
        upVotes: true,
        downVotes: true,
      },
      orderBy: { score: 'desc' },
      // take,
    });
    results.push(
      ...tags.map(({ tagId, tagName, tagType, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        name: tagName,
      }))
    );
    if (userId) {
      const userVotes = await dbRead.tagsOnModelsVote.findMany({
        where: { modelId: id, userId },
        select: { tagId: true, vote: true },
      });

      for (const tag of results) {
        const userVote = userVotes.find((vote) => vote.tagId === tag.id);
        if (userVote) tag.vote = userVote.vote;
      }
    }
  } else if (type === 'image') {
    const tags = await dbRead.imageTag.findMany({
      where: { imageId: id, OR: [{ score: { gt: 0 } }, { tagType: 'Moderation' }] },
      select: {
        tagId: true,
        tagName: true,
        tagType: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
      },
      orderBy: { score: 'desc' },
      // take,
    });
    results.push(
      ...tags.map(({ tagId, tagName, tagType, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        name: tagName,
      }))
    );
    if (userId) {
      const userVotes = await dbRead.tagsOnImageVote.findMany({
        where: { imageId: id, userId },
        select: { tagId: true, vote: true },
      });

      for (const tag of results) {
        const userVote = userVotes.find((vote) => vote.tagId === tag.id);
        if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
      }
    }
  }

  return results;
};

type TagVotingInput = {
  userId: number;
  type: TagVotableEntityType;
  id: number;
  tags: number[] | string[];
  isModerator?: boolean;
};
const clearCache = async (userId: number, entityType: TagVotableEntityType) => {
  if (entityType === 'model') await userCache(userId).hidden.models.refresh();
  else if (entityType === 'image') await userCache(userId).hidden.images.refresh();
};

export const removeTagVotes = async ({ userId, type, id, tags }: TagVotingInput) => {
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  const isTagIds = typeof tags[0] === 'number';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');
  await dbWrite.$executeRawUnsafe(`
    DELETE FROM "${voteTable}"
    WHERE "userId" = ${userId}
      AND "${type}Id" = ${id}
      ${
        isTagIds
          ? `AND "tagId" IN (${tagIn})`
          : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
  `);

  await clearCache(userId, type);
};

const MODERATOR_VOTE_WEIGHT = 10;
export const addTagVotes = async ({
  userId,
  type,
  id,
  tags,
  isModerator,
  vote,
}: TagVotingInput & { vote: number }) => {
  vote *= isModerator ? MODERATOR_VOTE_WEIGHT : 1;
  const isTagIds = typeof tags[0] === 'number';
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  await dbWrite.$executeRawUnsafe(`
    INSERT INTO "${voteTable}" ("userId", "tagId", "${type}Id", "vote")
    SELECT
      ${userId}, id, ${id}, ${vote}
    FROM "Tag"
    WHERE ${tagSelector} IN (${tagIn})
    ON CONFLICT ("userId", "tagId", "${type}Id") DO UPDATE SET "vote" = ${vote}, "createdAt" = NOW()
  `);

  // If voting up a tag
  if (vote > 0) {
    // Check if it's a moderation tag
    const [{ count }] = await dbRead.$queryRawUnsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int "count" FROM "Tag"
      WHERE ${tagSelector} IN (${tagIn}) AND "type" = 'Moderation'
    `);
    if (count > 0) await clearCache(userId, type); // Clear cache if it is
  }
};
// #endregion

export const addTags = async ({ tags, entityIds, entityType }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');

  if (entityType === 'model') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT
        m."id", t."id"
      FROM "Model" m
      JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE m."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
    `);
  } else if (entityType === 'image') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnImage" ("imageId", "tagId")
      SELECT
        i."id", t."id"
      FROM "Image" i
      JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE i."id" IN (${entityIds.join(', ')})
      ON CONFLICT ("imageId", "tagId") DO UPDATE SET "disabled" = false, "needsReview" = false, automated = false
    `);
  } else if (entityType === 'tag') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnTags" ("fromTagId", "toTagId")
      SELECT
        fromTag."id", toTag."id"
      FROM "Tag" toTag
      JOIN "Tag" fromTag ON fromTag.${tagSelector} IN (${tagIn})
      WHERE toTag."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
    `);
  }
};

export const disableTags = async ({ tags, entityIds, entityType }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');

  if (entityType === 'model') {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "TagsOnModels"
      SET "disabled" = true
      WHERE "modelId" IN (${entityIds.join(', ')})
      ${
        isTagIds
          ? `AND "tagId" IN (${tagIn})`
          : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
    `);
  } else if (entityType === 'image') {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "TagsOnImage"
      SET "disabled" = true, "needsReview" = false
      WHERE "imageId" IN (${entityIds.join(', ')})
      ${
        isTagIds
          ? `AND "tagId" IN (${tagIn})`
          : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
    `);
  } else if (entityType === 'tag') {
    await dbWrite.$executeRawUnsafe(`
      DELETE FROM "TagsOnTags"
      WHERE "toTagId" IN (${entityIds.join(', ')})
      ${
        isTagIds
          ? `AND "fromTagId" IN (${tagIn})`
          : `AND "fromTagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
    `);
  }
};

export const moderateTags = async ({ entityIds, entityType, disable }: ModerateTagsSchema) => {
  if (entityType === 'model') {
    // We aren't doing user model tagging quite yet...
    throw new Error('Not implemented');
    // await dbWrite.$executeRawUnsafe(`
    //   UPDATE "TagsOnModels"
    //   SET "disabled" = ${disable}, "needsReview" = false
    //   WHERE "needsReview" = true AND "modelId" IN (${entityIds.join(', ')})
    // `);
  } else if (entityType === 'image') {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "TagsOnImage"
      SET "disabled" = ${disable}, "needsReview" = false, "automated" = false
      WHERE "needsReview" = true AND "imageId" IN (${entityIds.join(', ')})
    `);

    // Update nsfw baseline
    if (disable) {
      await dbWrite.$executeRawUnsafe(`
        -- Update NSFW baseline
        UPDATE "Image" SET nsfw = false
        WHERE id IN (${entityIds.join(', ')})
          AND NOT EXISTS (
            SELECT 1
            FROM "TagsOnImage" toi
            JOIN "Tag" t ON t.id = toi."tagId" AND t.type = 'Moderation'
            WHERE toi."imageId" = "Image".id
              AND toi."disabled" = false
          )
      `);
    }
  }
};

export const deleteTags = async ({ tags }: DeleteTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');

  await dbWrite.$executeRawUnsafe(`
    DELETE FROM "Tag"
    WHERE ${tagSelector} IN (${tagIn})
  `);
};
