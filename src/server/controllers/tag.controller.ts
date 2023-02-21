import { constants } from '~/server/common/constants';
import { GetTagByNameInput, GetTagsInput, GetTrendingTagsSchema } from '~/server/schema/tag.schema';
import { getTags, getTagWithModelCount } from '~/server/services/tag.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

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
