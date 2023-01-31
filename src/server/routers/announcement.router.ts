import { router, publicProcedure } from '~/server/trpc';
import { getLastestSchema } from '~/server/schema/announcement.schema';
import { getLastestHandler } from '~/server/controllers/announcement.controller';

export const announcementRouter = router({
  getLatest: publicProcedure.input(getLastestSchema).query(getLastestHandler),
});
