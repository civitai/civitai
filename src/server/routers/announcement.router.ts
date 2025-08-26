import { router, publicProcedure, moderatorProcedure, middleware } from '~/server/trpc';
import {
  getAnnouncementsPagedSchema,
  getCurrentAnnouncementsSchema,
  upsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import {
  deleteAnnouncement,
  getAnnouncementsPaged,
  getCurrentAnnouncements,
  upsertAnnouncement,
} from '~/server/services/announcement.service';
import { getByIdSchema } from '~/server/schema/base.schema';
import { applyRequestDomainColor } from '~/server/middleware.trpc';

export const announcementRouter = router({
  upsertAnnouncement: moderatorProcedure
    .input(upsertAnnouncementSchema)
    .mutation(({ input }) => upsertAnnouncement(input)),
  deleteAnnouncement: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteAnnouncement(input.id)),
  getAnnouncements: publicProcedure
    .input(getCurrentAnnouncementsSchema.optional())
    .use(applyRequestDomainColor)
    .query(({ ctx, input }) => getCurrentAnnouncements({ ...input, userId: ctx.user?.id })),
  getAnnouncementsPaged: moderatorProcedure
    .input(getAnnouncementsPagedSchema)
    .query(({ input }) => getAnnouncementsPaged(input)),
});
