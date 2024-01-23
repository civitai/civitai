import { TagsOnTagsType, TagType } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import {
  AddTagVotesSchema,
  AdjustTagsSchema,
  DeleteTagsSchema,
  GetTagByNameInput,
  GetTagsInput,
  GetTrendingTagsSchema,
  GetVotableTagsSchema,
  ModerateTagsSchema,
  RemoveTagVotesSchema,
} from '~/server/schema/tag.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getHomeExcludedTags } from '~/server/services/system-cache';
import {
  addTags,
  addTagVotes,
  deleteTags,
  disableTags,
  getTags,
  getTagWithModelCount,
  getVotableTags,
  moderateTags,
  removeTagVotes,
} from '~/server/services/tag.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getTagWithModelCountHandler = ({ input: { name } }: { input: GetTagByNameInput }) => {
  try {
    return getTagWithModelCount({ name });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAllTagsHandler = async ({ input, ctx }: { input?: GetTagsInput; ctx: Context }) => {
  try {
    const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
    const { take, skip } = getPagination(limit, page);
    const { adminTags } = getFeatureFlags({ user: ctx?.user });

    const results = await getTags({
      ...input,
      take,
      skip,
      includeAdminTags: adminTags,
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

type ManageableTagRow = {
  id: number;
  name: string;
  type: TagType;
  target: string[];
  createdAt: Date;
  modelCount: number;
  imageCount: number;
  postCount: number;
};
type TagRelationshipRow = { fromId: number; toId: number; type: TagsOnTagsType; fromName: string };
export const getManagableTagsHandler = async () => {
  const resultsRaw = await dbRead.$queryRaw<ManageableTagRow[]>`
    SELECT
      t.id,
      t.name,
      t.type,
      t.target,
      t."createdAt",
      COALESCE(m."modelCount", 0) AS "modelCount",
      COALESCE(m."imageCount", 0) AS "imageCount",
      COALESCE(m."postCount", 0) AS "postCount"
    FROM "Tag" t
    LEFT JOIN "TagMetric" m ON m."tagId" = t.id AND m.timeframe = 'AllTime'::"MetricTimeframe"
  `;

  const relationships = await dbRead.$queryRaw<TagRelationshipRow[]>`
    SELECT
      "fromTagId" as "fromId",
      "toTagId" as "toId",
      r.type,
      t.name AS "fromName"
    FROM "TagsOnTags" r
    JOIN "Tag" t ON t.id = r."fromTagId"
  `;

  const results = resultsRaw.map((x) => ({
    ...x,
    tags: relationships
      .filter((r) => r.toId === x.id)
      .map((r) => ({ id: r.toId, name: r.fromName, relationship: r.type })),
  }));

  return results;
};

export const getTrendingTagsHandler = async ({ input }: { input: GetTrendingTagsSchema }) => {
  const { items } = await getTags({
    ...input,
    take: input.limit ?? constants.tagFilterDefaults.trendingTagsLimit,
  });

  return items;
};

export const getVotableTagsHandler = async ({
  input,
  ctx,
}: {
  input: GetVotableTagsSchema;
  ctx: Context;
}) => {
  try {
    const results = await getVotableTags({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });

    return results;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const addTagVotesHandler = async ({
  input,
  ctx,
}: {
  input: AddTagVotesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await addTagVotes({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const removeTagVotesHandler = async ({
  input,
  ctx,
}: {
  input: RemoveTagVotesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await removeTagVotes({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const addTagsHandler = async ({ input }: { input: AdjustTagsSchema }) => {
  try {
    await addTags(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const disableTagsHandler = async ({ input }: { input: AdjustTagsSchema }) => {
  try {
    await disableTags(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const moderateTagsHandler = async ({
  input,
  ctx,
}: {
  input: ModerateTagsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await moderateTags(input);
    await trackModActivity(ctx.user.id, {
      entityType: input.entityType,
      entityId: input.entityIds,
      activity: 'moderateTag',
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteTagsHandler = async ({ input }: { input: DeleteTagsSchema }) => {
  try {
    await deleteTags(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getHomeExcludedTagsHandler = async () => {
  try {
    const tags = await getHomeExcludedTags();
    return tags;
  } catch (error) {
    throw throwDbError(error);
  }
};
