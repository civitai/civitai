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
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const announcementRouter = router({
  upsertAnnouncement: moderatorProcedure
    .input(upsertAnnouncementSchema)
    .mutation(({ input }) => upsertAnnouncement(input)),
  deleteAnnouncement: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteAnnouncement(input.id)),
  getAnnouncements: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getCurrentAnnouncementsSchema.default({}))
    .use(applyRequestDomainColor)
    .query(({ ctx, input }) => getCurrentAnnouncements({ ...input, userId: ctx.user?.id })),
  getAnnouncementsPaged: moderatorProcedure
    .input(getAnnouncementsPagedSchema)
    .query(({ input }) => getAnnouncementsPaged(input)),
});
