import { TRPCError } from '@trpc/server';
import type { ProtectedContext } from '~/server/createContext';
import type { HideDownloadInput } from '~/server/schema/download.schema';
import { getUserDownloads, hideDownload } from '~/server/services/download.service';
import { heldGalleryViewer } from '~/server/services/model.service';
import { throwDbError } from '~/server/utils/errorHandling';

export const getUserDownloadsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  const { id: userId } = ctx.user;

  try {
    // Service returns all downloads (up to 2000, limited by ClickHouse query)
    const { items } = await getUserDownloads({ userId, viewer: heldGalleryViewer(ctx) });
    return { items };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const hideDownloadHandler = async ({
  input,
  ctx,
}: {
  input: HideDownloadInput;
  ctx: ProtectedContext;
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
