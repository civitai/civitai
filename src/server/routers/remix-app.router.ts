import * as z from 'zod';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  listRemixApps,
  quoteRemixApps,
  quoteTeamRemix,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import type { Context } from '~/server/createContext';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const remixAppProcedure = protectedProcedure.use(isFlagProtected('remixApps'));

const imageId = z.number().int().positive();

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
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId }))
    .query(async ({ ctx, input }) => quoteRemixApps({ ...input, caller: await getCaller(ctx) })),
  teamQuote: remixAppProcedure
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
    .input(z.object({ slug: z.string().max(64), imageId, nonce: z.string().min(8).max(64) }))
    .mutation(async ({ ctx, input }) => runRemixApp({ ...input, caller: await getCaller(ctx) })),
});
