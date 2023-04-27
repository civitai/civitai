import { addViewSchema } from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';

export const trackRouter = router({
  addView: publicProcedure.input(addViewSchema).mutation(({ input, ctx }) => ctx.track.view(input)),
});
