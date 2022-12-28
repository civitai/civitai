import { GetTagByNameInput, GetTagsInput } from '~/server/schema/tag.schema';
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
    const { withModels = false, limit = DEFAULT_PAGE_SIZE, page, query, entityType } = input || {};
    const { take, skip } = getPagination(limit, page);

    const results = await getTags({
      take,
      skip,
      query,
      target: entityType,
      select: withModels
        ? {
            id: true,
            name: true,
            tagsOnModels: { select: { modelId: true } },
          }
        : { id: true, name: true },
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};
