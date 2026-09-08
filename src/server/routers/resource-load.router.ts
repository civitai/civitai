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
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';

/**
 * Loading a model is a member benefit. Same derivation the generation form uses
 * (`status.tier !== 'free' || isModerator`), stated once here so the two cannot drift.
 *
 * 🔴 Not left to the rate limiter's `limit: 0` free row. That row does refuse a free user, but
 * `rateLimit()` short-circuits entirely for moderators AND in dev/test/preview — so on a preview
 * build the only thing standing between a free account and a free model load would be a middleware
 * that had already returned. This is the gate; the rate limit is the quota.
 */
export function assertCanRequestLoad(user: SessionUser) {
  if (user.isModerator) return;
  if (!user.tier || user.tier === 'free')
    throw throwAuthorizationError('Loading models is a member benefit.');
}

/**
 * Two windows, and they mean different things.
 *
 * **Daily rows are entitlement** — what a plan includes. **The hourly row is the cluster's**, so it
 * is flat and unconditional: no plan buys its way out of burst protection.
 *
 * The middleware keeps ONE list of attempt timestamps per key and filters it per rule, so the two
 * windows compose on the same `sharedKey` with no extra bookkeeping. Per period the highest
 * matching limit wins, which is what lets the unconditional daily row sit alongside the tier rows.
 *
 * 🔴 The unconditional daily row is required, not stylistic: a tier matching NO row gets no limit at
 * all — `validLimits` comes out empty and the check loop never runs. `userTiers` is
 * `[free, founder, bronze, silver, gold]`, so `founder` needs its own row too.
 *
 * The comparison is `attempts > limit`, so every nonzero number permits one more than it says —
 * 3/hour is really 4 (`limit: 0` short-circuits and is exact).
 */
export const RESOURCE_LOAD_HOURLY_LIMIT = 3;

export const resourceLoadRateLimits = [
  { limit: 0, period: CacheTTL.day, errorMessage: 'Loading models is a member benefit.' },
  { limit: 3, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'bronze' },
  { limit: 6, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'silver' },
  { limit: 10, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'gold' },
  { limit: 10, period: CacheTTL.day, userReq: (u: { tier?: string }) => u.tier === 'founder' },
  {
    limit: RESOURCE_LOAD_HOURLY_LIMIT,
    period: CacheTTL.hour,
    errorMessage: 'You can only queue a few model loads an hour. Try again shortly.',
  },
];

export const resourceLoadRouter = router({
  /**
   * 🔴 Flag-gated, and not for tidiness. `getState` takes up to 100 version ids and makes one
   * uncached orchestrator call per id, so ungated it is an unauthenticated amplifier: one request,
   * a hundred grain calls, repeatable by anyone. Drop the flag guard when C5 puts load state on the
   * model page — and give it a cache or a cap when you do.
   */
  getState: publicProcedure
    .use(isFlagProtected('resourceLoad'))
    .input(getResourceLoadStateSchema)
    .query(({ input }) => getResourceLoadState(input.modelVersionIds)),
  getQueue: publicProcedure
    .use(isFlagProtected('resourceLoad'))
    .input(getResourceLoadQueueSchema)
    .query(({ input }) => getResourceLoadQueue(input)),
  // Only `protectedProcedure`, so a user who has not finished onboarding still sees a price rather
  // than a dead button.
  estimate: protectedProcedure
    .use(isFlagProtected('resourceLoad'))
    .input(resourceLoadVersionSchema)
    .mutation(async ({ input, ctx }) => {
      assertCanRequestLoad(ctx.user);
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
      assertCanRequestLoad(ctx.user);
      const token = await getOrchestratorToken(ctx.user.id, ctx);
      return submitResourceLoad({
        modelVersionId: input.modelVersionId,
        userId: ctx.user.id,
        token,
        currencies: getAllowedAccountTypes(ctx.features),
      });
    }),
});
