import {
  addViewSchema,
  trackActionSchema,
  trackSearchSchema,
  trackShareSchema,
} from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';

export const trackRouter = router({
  addView: publicProcedure.input(addViewSchema).mutation(({ input, ctx }) => ctx.track.view(input)),
  trackShare: publicProcedure
    .input(trackShareSchema)
    .mutation(({ input, ctx }) => ctx.track.share(input)),
  addAction: publicProcedure
    .input(trackActionSchema)
    .mutation(({ input, ctx }) => ctx.track.action(input)),
  trackSearch: publicProcedure
    .input(trackSearchSchema)
    .mutation(({ input, ctx }) => ctx.track.search(input)),
});
