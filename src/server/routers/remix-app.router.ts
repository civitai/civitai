import * as z from 'zod';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  listRemixApps,
  quoteRemixApps,
  quoteTeamRemix,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import {
  advanceRemixRun,
  postRemixResult,
  REMIX_RUN_ID,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import { POST_CREATE_RATE_LIMIT_KEY, postRateLimits } from '~/server/schema/post.schema';
import type { Context } from '~/server/createContext';
import { rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  router,
} from '~/server/trpc';
import {
  listRemixAppsForAdmin,
  orderRemixApps,
  saveRemixApp,
  setRemixAppEnabled,
  deleteRemixApp,
} from '~/server/services/remix-app-registry.service';
import { remixAppInputSchema, remixAppSlugSchema } from '~/shared/remix-apps/row.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const remixAppProcedure = protectedProcedure.use(isFlagProtected('remixApps'));
const remixAppAdminProcedure = moderatorProcedure.use(isFlagProtected('remixApps'));

const imageId = z.number().int().positive();

/** Each uncached quote is an orchestrator what-if. */
const quoteRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });
/** Called on every image view; it only reaches a what-if for an image the viewer can team-remix. */
const teamQuoteRateLimit = rateLimit({ limit: 120, period: CacheTTL.xs });
/** run, start and advance each price the next workflow with a what-if before they submit it. */
const runStepRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });

const nonce = z.string().min(8).max(64);
const quote = z.number().int().nonnegative();
const gallery = z
  .object({
    hostImageId: imageId,
    method: z.enum(['free', 'team', 'paid']),
    expectedPrice: z.number().int().min(0).optional(),
  })
  // The gallery service reads a missing price as consent to the owner's current one.
  .superRefine((input, ctx) => {
    if (input.method === 'paid' && input.expectedPrice == null)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedPrice'],
        message: 'A paid submission has to carry the price it was shown',
      });
  });

const answer = z.union([z.string().max(1000), z.number().int().nonnegative()]);

function callerOf(ctx: Context & { user: SessionUser }): Omit<RemixAppCaller, 'token'> {
  return {
    user: ctx.user,
    features: ctx.features,
    isGreenDomain: ctx.domain === 'green',
    isApiCaller: ctx.apiKeyId != null,
    track: ctx.track,
  };
}

export async function getCaller(ctx: Context & { user: SessionUser }): Promise<RemixAppCaller> {
  return { ...callerOf(ctx), token: await getOrchestratorToken(ctx.user.id, ctx) };
}

/** Mod-only: the remix app rows, and a test run that spends only on a confirmed quote. */
const remixAppAdminRouter = router({
  list: remixAppAdminProcedure.query(() => listRemixAppsForAdmin()),
  save: remixAppAdminProcedure
    .input(remixAppInputSchema)
    .mutation(({ input }) => saveRemixApp(input)),
  setEnabled: remixAppAdminProcedure
    .input(z.object({ slug: remixAppSlugSchema, enabled: z.boolean() }))
    .mutation(({ input }) => setRemixAppEnabled(input)),
  delete: remixAppAdminProcedure
    .input(z.object({ slug: remixAppSlugSchema }))
    .mutation(({ input }) => deleteRemixApp(input)),
  order: remixAppAdminProcedure
    .input(z.object({ slugs: remixAppSlugSchema.array().max(100) }))
    .mutation(({ input }) => orderRemixApps(input.slugs)),
  /** `start` for any app, disabled included; with no `quote` it only prices the first step. */
  testStart: remixAppAdminProcedure
    .use(runStepRateLimit)
    .input(
      z.object({
        slug: remixAppSlugSchema,
        imageId,
        nonce,
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input: { slug, imageId, nonce, answers, quote } }) =>
      startRemixRun({
        slug,
        imageId,
        nonce,
        answers,
        quote,
        caller: await getCaller(ctx),
        allowDisabled: true,
      })
    ),
});

export const remixAppRouter = router({
  admin: remixAppAdminRouter,
  list: remixAppProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(() => listRemixApps()),
  quote: remixAppProcedure
    .use(quoteRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId }))
    .query(async ({ ctx, input }) => quoteRemixApps({ ...input, caller: await getCaller(ctx) })),
  teamQuote: remixAppProcedure
    .use(teamQuoteRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId }))
    .query(({ ctx, input }) =>
      quoteTeamRemix({
        ...input,
        caller: callerOf(ctx),
        // Only for an eligible image: most image views never need a token.
        getToken: () => getOrchestratorToken(ctx.user.id, ctx),
      })
    ),
  run: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ slug: z.string().max(64), imageId, nonce, quote }))
    .mutation(async ({ ctx, input }) => runRemixApp({ ...input, caller: await getCaller(ctx) })),
  /** Without `quote`, a run whose next step is a workflow returns its price instead of submitting. */
  start: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        slug: z.string().max(64),
        imageId,
        nonce,
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => startRemixRun({ ...input, caller: await getCaller(ctx) })),
  advance: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        runId: z.string().regex(REMIX_RUN_ID),
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      advanceRemixRun({ ...input, caller: await getCaller(ctx) })
    ),
  /** Posts a finished run, published; `gallery` also submits it to the source's Remix gallery. */
  post: guardedProcedure
    .use(isFlagProtected('remixApps'))
    // `post.create`'s own limit, shared with it: this makes a post just as that does.
    .use(rateLimit(postRateLimits, undefined, { sharedKey: POST_CREATE_RATE_LIMIT_KEY }))
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.union([
        // A runtime run posts what the app returned, read by replaying the run.
        z.object({ runId: z.string().regex(REMIX_RUN_ID), gallery: gallery.optional() }),
        z.object({ workflowId: z.string().min(1).max(64), gallery: gallery.optional() }),
      ])
    )
    .mutation(async ({ ctx, input }) =>
      postRemixResult({
        ...input,
        caller: await getCaller(ctx),
        ctx,
      })
    ),
});
