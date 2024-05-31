import {
  addViewSchema,
  trackActionSchema,
  trackPlaySchema,
  trackSearchSchema,
  trackShareSchema,
} from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';
import { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';

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
  trackPlay: publicProcedure
    .input(trackPlaySchema)
    .mutation(({ input, ctx }) =>
      ctx.track.image({ ...input, type: 'Play', nsfw: NsfwLevelDeprecated.None })
    ),
});
