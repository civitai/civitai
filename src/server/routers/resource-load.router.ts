import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  getResourceLoadQueueSchema,
  getResourceLoadStateSchema,
  resourceLoadVersionSchema,
} from '~/server/schema/resource-load.schema';
import {
  estimateResourceLoad,
  getResourceLoadQueue,
  getResourceLoadState,
  submitResourceLoad,
} from '~/server/services/resource-load.service';
import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

/**
 * The unconditional row is required, not stylistic: a tier matching no row gets NO limit at all —
 * `validLimits` comes out empty and the check loop never runs. `userTiers` is
 * `[free, founder, bronze, silver, gold]`, so `founder` needs its own row too.
 *
 * The comparison is `attempts > limit`, so the nonzero numbers permit one load more than they say
 * (`limit: 0` short-circuits and is exact).
 */
const resourceLoadRateLimits = [
  { limit: 0, period: CacheTTL.day, errorMessage: 'Loading models is a member benefit.' },
  { limit: 3, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'bronze' },
  { limit: 6, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'silver' },
  { limit: 10, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'gold' },
  { limit: 10, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'founder' },
];

export const resourceLoadRouter = router({
  // Public: load state is shown to everyone on a model page, not only to whoever paid for it.
  getState: publicProcedure
    .input(getResourceLoadStateSchema)
    .query(({ input }) => getResourceLoadState(input.modelVersionIds)),
  getQueue: publicProcedure
    .input(getResourceLoadQueueSchema)
    .query(({ input }) => getResourceLoadQueue(input)),
  // Only `protectedProcedure`, so a user who has not finished onboarding still sees a price rather
  // than a dead button.
  estimate: protectedProcedure
    .use(isFlagProtected('resourceLoad'))
    .input(resourceLoadVersionSchema)
    .mutation(async ({ input, ctx }) => {
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      return estimateResourceLoad({
        modelVersionId: input.modelVersionId,
        token,
        currencies: getAllowedAccountTypes(ctx.features),
      });
    }),
  submit: guardedProcedure
    .use(isFlagProtected('resourceLoad'))
    // `onlyCountSuccess` so a refused purchase — unsupported, already resident, not enough Buzz —
    // does not burn one of the day's loads.
    .use(
      rateLimit(resourceLoadRateLimits, undefined, {
        onlyCountSuccess: true,
        sharedKey: 'resource-load:submit',
      })
    )
    .input(resourceLoadVersionSchema)
    .mutation(async ({ input, ctx }) => {
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      return submitResourceLoad({
        modelVersionId: input.modelVersionId,
        userId: ctx.user.id,
        token,
        currencies: getAllowedAccountTypes(ctx.features),
      });
    }),
});
