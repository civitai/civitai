import { addViewSchema, trackEventSchema, trackShareSchema } from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';

export const trackRouter = router({
  addView: publicProcedure.input(addViewSchema).mutation(({ input, ctx }) => ctx.track.view(input)),
  trackShare: publicProcedure
    .input(trackShareSchema)
    .mutation(({ input, ctx }) => ctx.track.share(input)),
  addEvent: publicProcedure
    .input(trackEventSchema)
    .mutation(({ input, ctx }) => ctx.track.event(input)),
});
