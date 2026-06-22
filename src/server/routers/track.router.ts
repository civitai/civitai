import {
  trackActionSchema,
  trackSearchSchema,
  trackShareSchema,
  addViewSchema,
  blockRenderSchema,
} from '~/server/schema/track.schema';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const trackRouter = router({
  addView: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(addViewSchema)
    .mutation(({ input, ctx }) => ctx.track.view(input)),
  // App Blocks Analytics Phase 2 — block render/impression. publicProcedure so
  // ANON viewers (the whole point of this event) can emit. `isAnon` is derived
  // SERVER-SIDE from the session here (`!ctx.user`) and is NOT part of the input
  // schema — a client cannot override it.
  //
  // The browser hosts (PageBlockHost / IframeHost) emit this via the lightweight
  // /api/track/block-render BEACON, not this procedure — the event fires per
  // model-page-with-a-block view + per /apps/run load, so at GA it must skip the
  // full tRPC middleware chain (mirrors the #2680 addView -> /api/track/view
  // move, which likewise left its tRPC procedure intact). This procedure is kept
  // for any bearer/API-key (non-cookie) caller, consistent with `addView`.
  blockRender: publicProcedure
    .input(blockRenderSchema)
    .mutation(({ input, ctx }) => ctx.track.blockRender({ ...input, isAnon: !ctx.user })),
  trackShare: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackShareSchema)
    .mutation(({ input, ctx }) => ctx.track.share(input)),
  addAction: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackActionSchema)
    .mutation(({ input, ctx }) => ctx.track.action(input)),
  trackSearch: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackSearchSchema)
    .mutation(({ input, ctx }) => ctx.track.search(input)),
});
