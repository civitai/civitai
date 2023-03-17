import { constants } from '~/server/common/constants';
import {
  AddTagVotesSchema,
  GetTagByNameInput,
  GetTagsInput,
  GetTrendingTagsSchema,
  GetVotableTagsSchema,
  RemoveTagVotesSchema,
} from '~/server/schema/tag.schema';
import {
  addTagVotes,
  getTags,
  getTagWithModelCount,
  getVotableTags,
  removeTagVotes,
} from '~/server/services/tag.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { Context } from '~/server/createContext';

export const getTagWithModelCountHandler = async ({
  input: { name },
}: {
  input: GetTagByNameInput;
}) => {
  try {
    return await getTagWithModelCount({ name });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAllTagsHandler = async ({ input }: { input?: GetTagsInput }) => {
  try {
    const { withModels = false, limit = DEFAULT_PAGE_SIZE, page } = input || {};
    const { take, skip } = getPagination(limit, page);

    const results = await getTags({
      ...input,
      take,
      skip,
      select: {
        id: true,
        name: true,
        isCategory: true,
        tagsOnModels: withModels ? { select: { modelId: true } } : false,
      },
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getTrendingTagsHandler = async ({ input }: { input: GetTrendingTagsSchema }) => {
  const { items } = await getTags({
    ...input,
    take: input.limit ?? constants.tagFilterDefaults.trendingTagsLimit,
    select: { id: true, name: true },
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
    await removeTagVotes({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};
