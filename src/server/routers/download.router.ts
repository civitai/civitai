import { protectedProcedure, router } from '~/server/trpc';
import { getUserDownloadsSchema, hideDownloadInput } from '~/server/schema/download.schema';
import {
  getUserDownloadsInfiniteHandler,
  hideDownloadHandler,
} from '~/server/controllers/download.controller';

export const downloadRouter = router({
  getAllByUser: protectedProcedure
    .input(getUserDownloadsSchema.partial())
    .query(getUserDownloadsInfiniteHandler),
  hide: protectedProcedure.input(hideDownloadInput).mutation(hideDownloadHandler),
});
