import { addViewHandler } from '~/server/controllers/track.controller';
import { addViewSchema } from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';

export const trackRouter = router({
  addView: publicProcedure.input(addViewSchema).mutation(addViewHandler),
});
