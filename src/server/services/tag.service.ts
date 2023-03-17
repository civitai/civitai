import { ModelStatus, Prisma } from '@prisma/client';
import { TagVotableEntityType, VotableTag } from '~/libs/tags';
import { TagSort } from '~/server/common/enums';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetTagsInput, GetVotableTagsSchema } from '~/server/schema/tag.schema';
import { userCache } from '~/server/services/user-cache.service';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await dbRead.tag.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          tagsOnModels: { where: { model: { status: ModelStatus.Published } } },
        },
      },
    },
  });
};

export const getTags = async <TSelect extends Prisma.TagSelect = Prisma.TagSelect>({
  select,
  take,
  skip,
  entityType,
  query,
  modelId,
  not,
  unlisted,
  categories,
  sort,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  select: TSelect;
  take?: number;
  skip?: number;
}) => {
  const where: Prisma.TagWhereInput = {
    name: query ? { startsWith: query, mode: 'insensitive' } : undefined,
    target: { hasSome: entityType },
    tagsOnModels: modelId ? { some: { modelId } } : undefined,
    id: not ? { notIn: not } : undefined,
    unlisted,
    isCategory: categories,
  };

  const orderBy: Prisma.Enumerable<Prisma.TagOrderByWithRelationInput> = [];
  if (sort === TagSort.MostImages) orderBy.push({ rank: { imageCountAllTimeRank: 'asc' } });
  else if (sort === TagSort.MostModels) orderBy.push({ rank: { modelCountAllTimeRank: 'asc' } });
  else if (sort === TagSort.MostPosts) orderBy.push({ rank: { postCountAllTimeRank: 'asc' } });

  const items = await dbRead.tag.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });
  const count = await dbRead.tag.count({ where });

  return { items, count };
};

// #region [tag voting]
export const getVotableTags = async ({
  userId,
  type,
  id,
  take = 20,
}: GetVotableTagsSchema & { userId?: number }) => {
  const results: VotableTag[] = [];
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
      take,
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
      where: { imageId: id, score: { gt: 0 } },
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
      take,
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
export const addTagVotes = async ({ userId, type, id, tags, isModerator }: TagVotingInput) => {
  const vote = isModerator ? MODERATOR_VOTE_WEIGHT : 1;
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

  await clearCache(userId, type);
};
// #endregion
