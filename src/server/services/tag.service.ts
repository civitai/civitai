import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import type { SessionUser } from 'next-auth';
import { isDev } from '~/env/other';
import type { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { constants } from '~/server/common/constants';
import { NsfwLevel, TagSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { imageTagsCache } from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type {
  AdjustTagsSchema,
  DeleteTagsSchema,
  GetTagsForReviewInput,
  GetTagsInput,
  GetVotableTagsSchema,
  GetVotableTagsSchema2,
  ModerateTagsSchema,
} from '~/server/schema/tag.schema';
import { modelTagCompositeSelect } from '~/server/selectors/tag.selector';
import { getCategoryTags, getSystemTags } from '~/server/services/system-cache';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  HiddenImages,
  HiddenModels,
  ImplicitHiddenImages,
} from '~/server/services/user-preferences.service';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { Flags } from '~/shared/utils/flags';
import { TagSource, TagTarget, TagType } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';

const alwaysIncludeTags = [...constants.imageTags.styles, ...constants.imageTags.subjects];

export const getTagWithModelCount = ({ name }: { name: string }) => {
  // No longer include count since we just have too many now...
  return dbRead.$queryRaw<[{ id: number; name: string; unfeatured: boolean; count: number }]>`
    SELECT "id",
           "name",
           "unfeatured",
           0 as count
    FROM "Tag"
    WHERE "name" = ${name}
    GROUP BY "id", "name"
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

// unused
export const getTagCountForImages = async (imageIds: number[]) => {
  if (!imageIds.length) return {};
  const results = await dbRead.$queryRaw<{ imageId: number; count: number }[]>`
    SELECT "public"."TagsOnImageDetails"."imageId",
           CAST(COUNT("public"."TagsOnImageDetails"."tagId") AS INTEGER) as count
    FROM "public"."TagsOnImageDetails"
    WHERE "public"."TagsOnImageDetails"."imageId" IN (${Prisma.join(imageIds)})
    GROUP BY "public"."TagsOnImageDetails"."imageId"
  `;

  return results.reduce((acc, { imageId, count }) => {
    acc[imageId] = count;
    return acc;
  }, {} as Record<number, number>);
};

export const getTags = async ({
  take,
  skip,
  types,
  entityType,
  query,
  modelId,
  excludedTagIds,
  unlisted = false,
  categories,
  sort,
  withModels = false,
  includeAdminTags = false,
  nsfwLevel,
  include,
  moderation,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  take?: number;
  skip?: number;
  includeAdminTags?: boolean;
}) => {
  const AND = [Prisma.sql`t."unlisted" = ${unlisted}`];

  // Exclude replaced tags
  // Yeah, it's a little weird that the toTagId is what we exclude, but it's for a consistent hierarchy elsewhere...
  AND.push(Prisma.sql`t.id NOT IN (SELECT "toTagId" FROM "TagsOnTags" WHERE type = 'Replace')`);

  if (query) AND.push(Prisma.sql`t."name" LIKE ${query + '%'}`);
  else {
    // When getting top tags,
    nsfwLevel = NsfwLevel.PG; // only get PG tags
    AND.push(Prisma.sql`NOT t.unfeatured`); // Exclude unfeatured tags
  }
  if (types?.length) AND.push(Prisma.sql`t."type"::text IN (${Prisma.join(types)})`);
  if (entityType)
    AND.push(Prisma.sql`t."target" && (ARRAY[${Prisma.join(entityType)}]::"TagTarget"[])`);
  if (modelId)
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "TagsOnModels" tom WHERE tom."tagId" = t."id" AND tom."modelId" = ${modelId})`
    );
  if (excludedTagIds && excludedTagIds.length > 0 && !query) {
    AND.push(Prisma.sql`t."id" NOT IN (${Prisma.join(excludedTagIds)})`);
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnTags" tot
      WHERE tot."toTagId" = t."id"
      AND tot."fromTagId" IN (${Prisma.join(excludedTagIds)})
      AND tot.type = 'Parent'
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
  if (!includeAdminTags) {
    AND.push(Prisma.sql`t."adminOnly" = false`);
  }

  if (moderation === false) {
    AND.push(Prisma.sql`t.type != 'Moderation'`);
  }

  if (nsfwLevel) AND.push(Prisma.sql`(t."nsfwLevel" & ${nsfwLevel}) != 0`);

  if (!sort) {
    if (entityType?.includes(TagTarget.Model)) sort = TagSort.MostModels;
    else if (entityType?.includes(TagTarget.Image)) sort = TagSort.MostImages;
    else if (entityType?.includes(TagTarget.Post)) sort = TagSort.MostPosts;
    else if (entityType?.includes(TagTarget.Article)) sort = TagSort.MostArticles;
  }

  const tagsOrderBy: string[] = [];
  if (query) tagsOrderBy.push(`LENGTH(t."name")`);
  if (isDev) tagsOrderBy.push(`t."name"`); // can't be bothered to update TagRank in gen_seed
  else if (sort === TagSort.MostImages) tagsOrderBy.push(`r."imageCountAllTimeRank"`);
  else if (sort === TagSort.MostModels) tagsOrderBy.push(`r."modelCountAllTimeRank"`);
  else if (sort === TagSort.MostPosts) tagsOrderBy.push(`r."postCountAllTimeRank"`);
  else if (sort === TagSort.MostArticles) tagsOrderBy.push(`r."articleCountAllTimeRank"`);
  else if (sort === TagSort.MostHidden) {
    tagsOrderBy.push(`r."hiddenCountAllTimeRank"`);
  }
  const orderBy = tagsOrderBy.length ? tagsOrderBy.join(', ') : `t."name" ASC`;

  const isCategory =
    !categories && !!categoryTags?.length
      ? Prisma.sql`, EXISTS (
        SELECT 1 FROM "TagsOnTags"
        WHERE "fromTagId" IN (${Prisma.join(categoryTags)})
        AND "toTagId" = t.id
      ) "isCategory"`
      : Prisma.sql``;

  const isNsfwLevel = include?.includes('nsfwLevel')
    ? Prisma.sql`, COALESCE(
      (
          SELECT MAX(pt."nsfwLevel")
          FROM "TagsOnTags" tot
          JOIN "Tag" pt ON tot."fromTagId" = pt.id
          WHERE tot."toTagId" = t.id
      ),
      t."nsfwLevel") "nsfwLevel"`
    : Prisma.sql``;

  const tagsRaw = await dbRead.$queryRaw<
    { id: number; name: string; isCategory?: boolean; nsfwLevel?: number }[]
  >`
    SELECT t."id",
           t."name"
           ${isCategory}
           ${isNsfwLevel}
    FROM "Tag" t
      ${Prisma.raw(orderBy.includes('r.') ? `JOIN "TagRank" r ON r."tagId" = t."id"` : '')}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${take} OFFSET ${skip}
  `;

  const models: Record<number, number[]> = {};
  // if (withModels) {
  //   const modelTags = await dbRead.tagsOnModels.findMany({
  //     where: { tagId: { in: tagsRaw.map((t) => t.id) } },
  //     select: { tagId: true, modelId: true },
  //   });
  //   for (const { tagId, modelId } of modelTags) {
  //     if (!models[tagId]) models[tagId] = [];
  //     models[tagId].push(modelId);
  //   }
  // }

  const items = tagsRaw.map((t) =>
    removeEmpty({
      ...t,
      models: withModels ? models[t.id] ?? [] : undefined,
    })
  );
  const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int count
    FROM "Tag" t
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  return { items, count };
};

// #region [tag voting]
export const getVotableTags = async ({
  userId,
  type,
  id,
  take = 100,
  isModerator = false,
}: GetVotableTagsSchema & {
  userId?: number;
  isModerator?: boolean;
}) => {
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
        nsfwLevel: 0,
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
    const voteCutoff = new Date(Date.now() + constants.tagVoting.voteDuration);

    // Fetch from cache
    const cachedData = await imageTagsCache.fetch(id);
    const cacheItem = cachedData[id];

    if (cacheItem) {
      const tags = cacheItem.tags.slice(0, take ?? 100);
      const hasWDTags = tags.some((x) => x.source === TagSource.WD14);
      results.push(
        ...tags
          .filter((x) => {
            if (x.source === TagSource.Rekognition && hasWDTags) {
              if (x.tagType === TagType.Moderation) return true;
              if (alwaysIncludeTags.includes(x.tagName)) return true;
              return false;
            }
            return true;
          })
          .map(({ tagId, tagName, tagType, tagNsfwLevel, source, ...tag }) => ({
            ...tag,
            id: tagId,
            type: tagType,
            nsfwLevel: tagNsfwLevel,
            name: tagName,
          }))
      );
    }
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
        tag.concrete ||
        (tag.lastUpvote && tag.lastUpvote > voteCutoff) ||
        (tag.vote && tag.vote > 0) ||
        (tag.needsReview && isModerator)
    );
  }

  return results;
};

export async function getVotableImageTags({
  ids,
  user,
  nsfwLevel,
}: {
  ids: number[];
  user: SessionUser;
  nsfwLevel?: number;
}) {
  // Fetch from cache
  const cachedData = await imageTagsCache.fetch(ids);

  // Process cached data
  const allImageTags: (VotableTagModel & { imageId: number })[] = [];
  const nsfwLevelArray = nsfwLevel ? Flags.instanceToArray(nsfwLevel) : null;

  for (const imageId of ids) {
    const cacheItem = cachedData[imageId];
    if (!cacheItem) continue;

    const imageTags = cacheItem.tags.filter(
      (tag) => !nsfwLevelArray || nsfwLevelArray.includes(tag.tagNsfwLevel)
    );

    const hasWDTags = imageTags.some((x) => x.source === TagSource.WD14);
    const filteredTags = imageTags
      .filter((x) => {
        if (x.source === TagSource.Rekognition && hasWDTags) {
          if (x.tagType === TagType.Moderation) return true;
          if (alwaysIncludeTags.includes(x.tagName)) return true;
          return false;
        }
        return true;
      })
      .map(({ tagId, tagName, tagType, tagNsfwLevel, source, ...tag }) => ({
        ...tag,
        imageId,
        id: tagId,
        type: tagType,
        nsfwLevel: tagNsfwLevel,
        name: tagName,
      })) as (VotableTagModel & { imageId: number })[];

    allImageTags.push(...filteredTags);
  }

  const userVotes = await dbRead.tagsOnImageVote.findMany({
    where: { imageId: { in: ids }, userId: user.id },
    select: { tagId: true, vote: true },
  });

  for (const tag of allImageTags) {
    const userVote = userVotes.find((vote) => vote.tagId === tag.id);
    if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
  }

  return allImageTags;
}

// TODO - create function for getting model tag votes and then finish abstracting this fuction - replaces `getVotableTags`
export async function getVotableTags2({
  ids,
  user,
  type,
  nsfwLevel,
}: GetVotableTagsSchema2 & { user: SessionUser }) {
  const voteCutoff = new Date(Date.now() + constants.tagVoting.voteDuration);
  const tagsFn = type === 'image' ? getVotableImageTags : getVotableImageTags;
  const tags = await tagsFn({ ids, user, nsfwLevel });
  return tags.filter(
    (tag) =>
      tag.concrete ||
      (tag.lastUpvote && tag.lastUpvote > voteCutoff) ||
      (tag.vote && tag.vote > 0) ||
      (tag.needsReview && user.isModerator)
  );
}

type TagVotingInput = {
  userId: number;
  type: TagVotableEntityType;
  id: number;
  tags: number[] | string[];
  isModerator?: boolean;
};
const clearCache = async (userId: number, entityType: TagVotableEntityType) => {
  if (entityType === 'model') await HiddenModels.refreshCache({ userId });
  else if (entityType === 'image') {
    await HiddenImages.refreshCache({ userId });
    await ImplicitHiddenImages.refreshCache({ userId });
  }
};

export const removeTagVotes = async ({ userId, type, id, tags }: TagVotingInput) => {
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  const isTagIds = typeof tags[0] === 'number';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');
  await dbWrite.$executeRawUnsafe(`
    DELETE
    FROM "${voteTable}"
    WHERE "userId" = ${userId}
      AND "${type}Id" = ${id}
      ${
        isTagIds
          ? `AND "tagId" IN (${tagIn})`
          : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
      }
  `);

  await clearCache(userId, type);

  // Bust image tags cache if voting on images
  if (type === 'image') {
    await imageTagsCache.bust(id);
  }
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
  if (isModerator) voteWeight = MODERATOR_VOTE_WEIGHT;
  else if (isCreator) voteWeight = CREATOR_VOTE_WEIGHT;

  vote *= voteWeight;
  const isTagIds = typeof tags[0] === 'number';
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? tags : tags.map((tag) => `'${tag}'`)).join(', ');
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  await dbWrite.$executeRawUnsafe(`
    INSERT INTO "${voteTable}" ("userId", "tagId", "${type}Id", "vote")
    SELECT ${userId},
           id,
           ${id},
           ${vote}
    FROM "Tag"
    WHERE ${tagSelector} IN (${tagIn})
    ON CONFLICT ("userId", "tagId", "${type}Id") DO UPDATE SET "vote"      = ${vote},
                                                               "createdAt" = NOW()
  `);

  // If voting up a tag
  if (vote > 0) {
    // Check if it's a moderation tag
    const [{ count }] = await dbRead.$queryRawUnsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int "count"
      FROM "Tag"
      WHERE ${tagSelector} IN (${tagIn})
        AND "type" = 'Moderation'
    `);
    if (count > 0) await clearCache(userId, type); // Clear cache if it is
  }

  // Bust image tags cache if voting on images
  if (type === 'image') {
    await imageTagsCache.bust(id);
  }
};
// #endregion

export const addTags = async ({ tags, entityIds, entityType, relationship }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

  if (entityType === 'model') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT m."id",
             t."id"
      FROM "Model" m
             JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE m."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
    `);
  } else if (entityType === 'image') {
    const result = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
      SELECT i."id" AS "imageId",  t."id" AS "tagId"
      FROM "Image" i
      JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE i."id" IN (${entityIds.join(', ')});
    `;
    await upsertTagsOnImageNew(
      result.map(({ imageId, tagId }) => ({
        imageId,
        tagId,
        automated: false,
        disabled: false,
        needsReview: false,
      }))
    );
  } else if (entityType === 'article') {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnArticle" ("articleId", "tagId")
      SELECT a."id",
             t."id"
      FROM "Article" a
             JOIN "Tag" t ON t.${tagSelector} IN (${tagIn})
      WHERE a."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
    `);
  } else if (entityType === 'tag') {
    if (!relationship) throw new Error('Relationship must be specified for tag tagging');

    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnTags" ("fromTagId", "toTagId", type)
      SELECT fromTag."id",
             toTag."id",
             '${relationship}'::"TagsOnTagsType"
      FROM "Tag" toTag
             JOIN "Tag" fromTag ON fromTag.${tagSelector} IN (${tagIn})
      WHERE toTag."id" IN (${entityIds.join(', ')})
      ON CONFLICT DO NOTHING
    `);

    // Bust cache for tag rules
    // The changes with Replace and Append are handled in the `apply-tag-rules` job
    if (relationship === 'Replace' || relationship === 'Append') {
      await redis.del(REDIS_KEYS.SYSTEM.TAG_RULES);
    }

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
        await redis.del(`${REDIS_KEYS.SYSTEM.CATEGORIES}:${tag.name.replace(' category', '')}`);
      } catch {}
    }
  }
};

export const findOrCreateTagsByName = async (tags: string[]) => {
  const uniqTags = uniq(tags.map((t) => t.toLowerCase().trim()));

  const foundTags = await dbWrite.tag.findMany({
    where: { name: { in: uniqTags } },
    select: { id: true, name: true },
  });

  const tagCache: { [p: string]: undefined | number } = Object.fromEntries(
    uniqTags.map((t) => [t, undefined])
  );

  for (const tag of foundTags) tagCache[tag.name] = tag.id;

  const newTags = Object.entries(tagCache)
    .filter(([, id]) => id === undefined)
    .map((t) => t[0]);
  if (newTags.length > 0) {
    // prisma...my dude. you really can't return the created rows?
    await dbWrite.tag.createMany({
      data: newTags.map((x) => ({
        name: x,
        type: TagType.UserGenerated,
        target: [TagTarget.Post],
      })),
    });
    const newFoundTags = await dbWrite.tag.findMany({
      where: { name: { in: newTags } },
      select: { id: true, name: true },
    });
    for (const tag of newFoundTags) {
      tagCache[tag.name] = tag.id;
    }
  }

  return tagCache;
};

export const disableTags = async ({ tags, entityIds, entityType }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

  // TODO.fix "disabled" doesnt exist for TagsOnModels, is this being used?
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
    const toUpdate = await dbWrite.$queryRawUnsafe<{ imageId: number; tagId: number }[]>(`
      SELECT "imageId", "tagId"
      FROM "TagsOnImageDetails"
      WHERE "imageId" IN (${entityIds.join(', ')})
        ${
          isTagIds
            ? `AND "tagId" IN (${tagIn})`
            : `AND "tagId" IN (SELECT id FROM "Tag" WHERE name IN (${tagIn}))`
        }
    `);

    await upsertTagsOnImageNew(
      toUpdate.map(({ imageId, tagId }) => ({ imageId, tagId, disabled: true, needsReview: false }))
    );
  } else if (entityType === 'tag') {
    await dbWrite.$executeRawUnsafe(`
      DELETE
      FROM "TagsOnTags"
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
    const toUpdate = await dbWrite.$queryRawUnsafe<{ imageId: number; tagId: number }[]>(`
      SELECT "imageId", "tagId"
      FROM "TagsOnImageDetails"
      WHERE "needsReview" = true
        AND "imageId" IN (${entityIds.join(', ')});
    `);

    await upsertTagsOnImageNew(
      toUpdate.map(({ imageId, tagId }) => ({
        imageId,
        tagId,
        automated: false,
        disabled: disable,
        needsReview: false,
      }))
    );
  }
};

export const deleteTags = async ({ tags }: DeleteTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagSelector = isTagIds ? 'id' : 'name';
  const tagIn = (isTagIds ? castedTags : castedTags.map((tag) => `'${tag}'`)).join(', ');

  // Get affected images before deletion (cascade will delete ImageTag records)
  const affectedImages = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "imageId"
    FROM "ImageTag"
    WHERE "tagId" IN (
      SELECT id FROM "Tag" WHERE ${tagSelector} IN (${tagIn})
    )
  `;

  await dbWrite.$executeRawUnsafe(`
    DELETE
    FROM "Tag"
    WHERE ${tagSelector} IN (${tagIn})
  `);

  // Bust cache for affected images
  if (affectedImages.length > 0) {
    const imageIds = affectedImages.map(x => x.imageId);
    await imageTagsCache.bust(imageIds);
  }
};

// unused
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

export async function getTagsForReview({ limit, page, reviewType }: GetTagsForReviewInput) {
  const pagination = getPagination(limit, page);
  const fromClause = Prisma.sql`
    FROM "ImageTagForReview" it
      JOIN "Tag" t ON it."tagId" = t.id
      JOIN "Image" i ON it."imageId" = i.id
    WHERE i."needsReview" = ${reviewType}
  `;

  const [tags, { count }] = await dbRead.$transaction([
    dbRead.$queryRaw<{ id: number; name: string }[]>`
      SELECT DISTINCT ON (t.name)
        t.id, t.name
      ${fromClause}
      ORDER BY t.name
      LIMIT ${pagination.take} OFFSET ${pagination.skip}
    `,
    dbRead.$queryRaw<{ count: number }>`
      SELECT
        COUNT(DISTINCT t.id) AS count
      ${fromClause}
    `,
  ]);

  return getPagingData({ items: tags, count }, pagination.take, page);
}
