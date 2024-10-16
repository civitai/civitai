import { router, publicProcedure, moderatorProcedure } from '~/server/trpc';
import {
  getAnnouncementsPagedSchema,
  upsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import {
  deleteAnnouncement,
  getAnnouncementsPaged,
  getCurrentAnnouncements,
  upsertAnnouncement,
} from '~/server/services/announcement.service';
import { getByIdSchema } from '~/server/schema/base.schema';

export const announcementRouter = router({
  upsertAnnouncement: moderatorProcedure
    .input(upsertAnnouncementSchema)
    .mutation(({ input }) => upsertAnnouncement(input)),
  deleteAnnouncement: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteAnnouncement(input.id)),
  getAnnouncements: publicProcedure.query(({ ctx }) =>
    getCurrentAnnouncements({ userId: ctx.user?.id })
  ),
  getAnnouncementsPaged: moderatorProcedure
    .input(getAnnouncementsPagedSchema)
    .query(({ input }) => getAnnouncementsPaged(input)),
});
