import { NsfwLevel, Prisma, TagTarget } from '@prisma/client';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { TagSort } from '~/server/common/enums';

import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import {
  AdjustTagsSchema,
  DeleteTagsSchema,
  GetTagsInput,
  GetVotableTagsSchema,
  ModerateTagsSchema,
} from '~/server/schema/tag.schema';
import { imageTagCompositeSelect, modelTagCompositeSelect } from '~/server/selectors/tag.selector';
import { getCategoryTags, getSystemTags } from '~/server/services/system-cache';
import { userCache } from '~/server/services/user-cache.service';

export const getTagWithModelCount = ({ name }: { name: string }) => {
  return dbRead.$queryRaw<[{ id: number; name: string; count: number }]>`
    SELECT "public"."Tag"."id",
      "public"."Tag"."name",
      CAST(COUNT("public"."TagsOnModels"."tagId") AS INTEGER) as count
    FROM "public"."Tag"
    LEFT JOIN "public"."TagsOnModels" ON "public"."Tag"."id" = "public"."TagsOnModels"."tagId"
    LEFT JOIN "public"."Model" ON "public"."TagsOnModels"."modelId" = "public"."Model"."id"
    WHERE "public"."Tag"."name" LIKE ${name}
      AND "public"."Model"."status" = 'Published'
      AND "public"."TagsOnModels"."modelId" IS NOT NULL
    GROUP BY "public"."Tag"."id", "public"."Tag"."name"
    LIMIT 1 OFFSET 0;
  `;
};

export const getTag = ({ id }: { id: number }) => {
  return dbRead.tag.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
    },
  });
};

export const getTags = async ({
  take,
  skip,
  types,
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
  if (types?.length) AND.push(Prisma.sql`t."type"::text IN (${Prisma.join(types)})`);
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

  const systemTags = await getSystemTags();
  const categoryTags = (
    entityType
      ? systemTags.filter((t) => t.name === `${entityType} category`.toLowerCase())
      : systemTags.filter((t) => t.name.endsWith('category'))
  ).map((x) => x.id);
  if (categories && categoryTags.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnTags" tot
      WHERE tot."toTagId" = t."id"
      AND tot."fromTagId" IN (${Prisma.join(categoryTags)})
    )`);
  }

  let orderBy = `t."name" ASC`;
  if (!sort) {
    if (entityType?.includes(TagTarget.Model)) sort = TagSort.MostModels;
    else if (entityType?.includes(TagTarget.Image)) sort = TagSort.MostImages;
    else if (entityType?.includes(TagTarget.Post)) sort = TagSort.MostPosts;
    else if (entityType?.includes(TagTarget.Article)) sort = TagSort.MostArticles;
  }

  if (query) {
    orderBy = `LENGTH(t."name")`;
    if (entityType?.includes(TagTarget.Model)) orderBy += `, r."modelCountAllTimeRank"`;
    if (entityType?.includes(TagTarget.Image)) orderBy += `, r."imageCountAllTimeRank"`;
    if (entityType?.includes(TagTarget.Post)) orderBy += `, r."postCountAllTimeRank"`;
  } else if (sort === TagSort.MostImages) orderBy = `r."imageCountAllTimeRank"`;
  else if (sort === TagSort.MostModels) orderBy = `r."modelCountAllTimeRank"`;
  else if (sort === TagSort.MostPosts) orderBy = `r."postCountAllTimeRank"`;
  else if (sort === TagSort.MostArticles) orderBy = `r."articleCountAllTimeRank"`;

  const isCategory =
    !categories && !!categoryTags?.length
      ? Prisma.sql`, EXISTS (
        SELECT 1 FROM "TagsOnTags"
        WHERE "fromTagId" IN (${Prisma.join(categoryTags)})
        AND "toTagId" = t.id
      ) "isCategory"`
      : Prisma.sql``;

  const tagsRaw = await dbRead.$queryRaw<{ id: number; name: string; isCategory?: boolean }[]>`
    SELECT
      t."id",
      t."name"
      ${isCategory}
    FROM "Tag" t
    ${Prisma.raw(orderBy.includes('r.') ? `LEFT JOIN "TagRank" r ON r."tagId" = t."id"` : '')}
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
  isModerator = false,
}: GetVotableTagsSchema & { userId?: number; isModerator?: boolean }) => {
  let results: VotableTagModel[] = [];
  if (type === 'model') {
    const tags = await dbRead.modelTag.findMany({
      where: { modelId: id, score: { gt: 0 } },
      select: modelTagCompositeSelect,
      orderBy: { score: 'desc' },
      // take,
    });
    results.push(
      ...tags.map(({ tagId, tagName, tagType, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        nsfw: NsfwLevel.None,
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
      select: imageTagCompositeSelect,
      orderBy: { score: 'desc' },
      // take,
    });
    results.push(
      ...tags.map(({ tagId, tagName, tagType, tagNsfw, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        nsfw: tagNsfw,
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
    results = results.filter(
      (tag) =>
        tag.type !== 'Moderation' ||
        tag.score > 0 ||
        (tag.vote && tag.vote > 0) ||
        (tag.needsReview && isModerator) ||
        (!tag.needsReview && tag.type === 'Moderation' && tag.score <= 0)
    );
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
const CREATOR_VOTE_WEIGHT = 3;
export const addTagVotes = async ({
  userId,
  type,
  id,
  tags,
  isModerator,
  vote,
}: TagVotingInput & { vote: number }) => {
  // Determine vote weight
  let isCreator = false;
  if (type === 'model') {
    const creator = await dbRead.model.findFirst({ where: { id }, select: { userId: true } });
    isCreator = creator?.userId === userId;
  } else if (type === 'image') {
    const creator = await dbRead.image.findFirst({ where: { id }, select: { userId: true } });
    isCreator = creator?.userId === userId;
  }
  let voteWeight = 1;
  if (isCreator) voteWeight = CREATOR_VOTE_WEIGHT;
  else if (isModerator) voteWeight = MODERATOR_VOTE_WEIGHT;

  vote *= voteWeight;
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
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

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
    updateImageNSFWLevels(entityIds);
  } else if (entityType === 'article') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnArticle" ("articleId", "tagId")
      SELECT
        a."id", t."id"
      FROM "Article" a
      JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE a."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
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

    // Clear cache for affected system tags
    const systemTags = await getSystemTags();
    for (const tag of systemTags) {
      if (
        isTagIds
          ? !(castedTags as number[]).includes(tag.id)
          : !(castedTags as string[]).includes(tag.name)
      )
        continue;

      try {
        await redis.del(`system:categories:${tag.name.replace(' category', '')}`);
      } catch {}
    }
  }
};

export const disableTags = async ({ tags, entityIds, entityType }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

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
      SET "disabled" = true, "needsReview" = false, "disabledAt" = NOW()
      WHERE "imageId" IN (${entityIds.join(', ')})
      ${
        isTagIds
          ? `AND "tagId" IN (${tagIn})`
          : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
    `);
    updateImageNSFWLevels(entityIds);
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
      SET
        "disabled" = ${disable},
        "needsReview" = false,
        "automated" = false,
        "disabledAt" = ${disable ? 'NOW()' : 'null'}
      WHERE "needsReview" = true AND "imageId" IN (${entityIds.join(', ')})
    `);

    // Update nsfw baseline
    if (disable) updateImageNSFWLevels(entityIds);
  }
};

const updateImageNSFWLevels = async (imageIds: number[]) => {
  await dbWrite.$executeRawUnsafe(`
    -- Update NSFW baseline
    SELECT update_nsfw_levels(ARRAY[${imageIds.join(',')}]);
  `);
};

export const deleteTags = async ({ tags }: DeleteTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

  await dbWrite.$executeRawUnsafe(`
    DELETE FROM "Tag"
    WHERE ${tagSelector} IN (${tagIn})
  `);
};

export const getTypeCategories = async ({
  type,
  excludeIds,
  limit,
  cursor,
}: {
  type: 'image' | 'model' | 'post' | 'article';
  excludeIds?: number[];
  limit?: number;
  cursor?: number;
}) => {
  let categories = await getCategoryTags(type);
  if (excludeIds) categories = categories.filter((c) => !excludeIds.includes(c.id));
  let start = 0;
  if (cursor) start = categories.findIndex((c) => c.id === cursor);
  if (limit) categories = categories.slice(start, start + limit);

  return categories;
};
