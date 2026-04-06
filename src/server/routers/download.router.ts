import { protectedProcedure, router } from '~/server/trpc';
import { hideDownloadInput } from '~/server/schema/download.schema';
import {
  getUserDownloadsHandler,
  hideDownloadHandler,
} from '~/server/controllers/download.controller';

export const downloadRouter = router({
  getAllByUser: protectedProcedure.query(getUserDownloadsHandler),
  hide: protectedProcedure.input(hideDownloadInput).mutation(hideDownloadHandler),
});
