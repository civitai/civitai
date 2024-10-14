import { router, publicProcedure } from '~/server/trpc';
import { getLastestSchema } from '~/server/schema/announcement.schema';
import { getLastestHandler } from '~/server/controllers/announcement.controller';
import { getAnnouncements } from '~/server/services/announcement.service';

export const announcementRouter = router({
  getLatest: publicProcedure.input(getLastestSchema).query(getLastestHandler),
  getAnnouncements: publicProcedure.query(({ ctx, input }) => getAnnouncements({ user: ctx.user })),
});
