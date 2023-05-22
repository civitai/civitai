import { constants } from '~/server/common/constants';
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
import {
  addTags,
  disableTags,
  moderateTags,
  addTagVotes,
  getTags,
  getTagWithModelCount,
  getVotableTags,
  removeTagVotes,
  deleteTags,
} from '~/server/services/tag.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';

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

export const getManagableTagsHandler = async () => {
  const results = (
    (await dbRead.tag.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        target: true,
        createdAt: true,
        fromTags: {
          select: {
            fromTag: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
        },
        stats: {
          select: {
            modelCountAllTime: true,
            imageCountAllTime: true,
            postCountAllTime: true,
          },
        },
      },
    })) ?? []
  ).map(({ fromTags, stats, ...tag }) => ({
    ...tag,
    stats: {
      modelCount: stats?.modelCountAllTime ?? 0,
      imageCount: stats?.imageCountAllTime ?? 0,
      postCount: stats?.postCountAllTime ?? 0,
    },
    tags: fromTags.map(({ fromTag }) => fromTag),
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
