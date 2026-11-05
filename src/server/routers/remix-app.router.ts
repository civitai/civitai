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
  listRemixRuns,
  REMIX_RUN_ID,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import type { Context } from '~/server/createContext';
import { rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const remixAppProcedure = protectedProcedure.use(isFlagProtected('remixApps'));

const imageId = z.number().int().positive();

/** Each uncached quote is an orchestrator what-if. */
const quoteRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });
/** Called on every image view; it only reaches a what-if for an image the viewer can team-remix. */
const teamQuoteRateLimit = rateLimit({ limit: 120, period: CacheTTL.xs });
/** start and advance each price the next workflow with a what-if before they submit it. */
const runStepRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });
/** Each call reads up to 100 of the viewer's workflows from the orchestrator. */
const runsRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });

const nonce = z.string().min(8).max(64);
const quote = z.number().int().nonnegative();
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

async function getCaller(ctx: Context & { user: SessionUser }): Promise<RemixAppCaller> {
  return { ...callerOf(ctx), token: await getOrchestratorToken(ctx.user.id, ctx) };
}

export const remixAppRouter = router({
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
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ slug: z.string().max(64), imageId, nonce }))
    .mutation(async ({ ctx, input }) => runRemixApp({ ...input, caller: await getCaller(ctx) })),
  /** Without `quote`, a run whose next step is a workflow returns its price instead of submitting. */
  start: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ slug: z.string().max(64), imageId, nonce, quote: quote.optional() }))
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
  runs: remixAppProcedure
    .use(runsRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(async ({ ctx }) => listRemixRuns({ caller: await getCaller(ctx) })),
});
