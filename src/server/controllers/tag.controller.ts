import { GetTagsInput } from '~/server/schema/tag.schema';
import { getTags } from '~/server/services/tag.service';
import { handleDbError } from '~/server/utils/errorHandling';

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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};
