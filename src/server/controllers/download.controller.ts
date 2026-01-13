import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import type { GetUserDownloadsSchema, HideDownloadInput } from '~/server/schema/download.schema';
import { getUserDownloads, hideDownload } from '~/server/services/download.service';
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
    // Service handles pagination internally and returns nextCursor
    const { items, nextCursor } = await getUserDownloads({
      ...input,
      limit,
      userId,
    });

    return { items, nextCursor };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const hideDownloadHandler = async ({
  input,
  ctx,
}: {
  input: HideDownloadInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await hideDownload({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
