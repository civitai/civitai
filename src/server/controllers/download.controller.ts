import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { getAllDownloadsSelect } from '~/server/selectors/download.selector';
import { getUserDownloads, updateUserActivityById } from '~/server/services/download.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserDownloadsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: Partial<GetUserDownloadsSchema>;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id: userId } = ctx.user;
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;

  try {
    const { items } = await getUserDownloads({
      ...input,
      limit: limit + 1,
      userId,
      select: getAllDownloadsSelect,
    });

    let nextCursor: number | undefined;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return { items, nextCursor };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const hideDownloadHandler = async ({ input }: { input: HideDownloadInput }) => {
  try {
    const download = await updateUserActivityById({
      ...input,
      data: { hide: true },
    });

    if (!download) throw throwNotFoundError(`No download with id ${input.id}`);

    return { download };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
