import * as z from 'zod';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  listRemixApps,
  quoteRemixApps,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import type { Context } from '~/server/createContext';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const remixAppProcedure = protectedProcedure.use(isFlagProtected('remixApps'));

const imageId = z.number().int().positive();

async function getCaller(ctx: Context & { user: SessionUser }): Promise<RemixAppCaller> {
  return {
    user: ctx.user,
    token: await getOrchestratorToken(ctx.user.id, ctx),
    features: ctx.features,
    isGreenDomain: ctx.domain === 'green',
    isApiCaller: ctx.apiKeyId != null,
    track: ctx.track,
  };
}

export const remixAppRouter = router({
  list: remixAppProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(() => listRemixApps()),
  quote: remixAppProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId }))
    .query(async ({ ctx, input }) => quoteRemixApps({ ...input, caller: await getCaller(ctx) })),
  run: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ slug: z.string().max(64), imageId, nonce: z.string().min(8).max(64) }))
    .mutation(async ({ ctx, input }) => runRemixApp({ ...input, caller: await getCaller(ctx) })),
});
