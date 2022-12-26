import { protectedProcedure, router } from '~/server/trpc';
import {
  getUserNotificationsInfiniteHandler,
  markReadNotificationHandler,
  upsertUserNotificationSettingsHandler,
} from '~/server/controllers/notification.controller';
import { getUserDownloadsSchema, hideDownloadInput } from '~/server/schema/download.schema';

export const downloadRouter = router({
  getAllByUser: protectedProcedure
    .input(getUserDownloadsSchema.partial())
    .query(getUserDownloadsInfiniteHandler),
  hide: protectedProcedure.input(hideDownloadInput).mutation(hideDownloadHandler),
});
