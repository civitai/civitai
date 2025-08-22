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
import { getRequestDomainColor } from '~/shared/constants/domain.constants';

const requestDomainColor = middleware(async (options) => {
  const { next, ctx } = options;
  const input = options.rawInput as { domain?: string };
  const domainColor = getRequestDomainColor(ctx.req);
  if (input.domain && input.domain !== domainColor) input.domain = domainColor;
  else input.domain = domainColor;

  return next();
});

export const announcementRouter = router({
  upsertAnnouncement: moderatorProcedure
    .input(upsertAnnouncementSchema)
    .mutation(({ input }) => upsertAnnouncement(input)),
  deleteAnnouncement: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => deleteAnnouncement(input.id)),
  getAnnouncements: publicProcedure
    .input(getCurrentAnnouncementsSchema.optional())
    .use(requestDomainColor)
    .query(({ ctx, input }) => getCurrentAnnouncements({ ...input, userId: ctx.user?.id })),
  getAnnouncementsPaged: moderatorProcedure
    .input(getAnnouncementsPagedSchema)
    .query(({ input }) => getAnnouncementsPaged(input)),
});
