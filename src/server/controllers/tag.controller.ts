import { GetTagsInput } from '~/server/schema/tag.schema';
import { getTags } from '~/server/services/tag.service';
import { throwDbError } from '~/server/utils/errorHandling';

export const getAllTagsHandler = async ({ input }: { input?: GetTagsInput }) => {
  try {
    return await getTags({
      ...input,
      select: {
        id: true,
        name: true,
      },
    });
  } catch (error) {
    throwDbError(error);
  }
};
