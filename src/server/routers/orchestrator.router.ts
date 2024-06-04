import { z } from 'zod';
import { workflowQuerySchema, workflowIdSchema } from './../schema/orchestrator/workflows.schema';
import {
  textToImageSchema,
  textToImageWhatIfSchema,
  textToImageWorkflowUpdateSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  createTextToImage,
  whatIfTextToImage,
  getTextToImageRequests,
  updateTextToImageWorkflow,
} from '~/server/services/orchestrator/textToImage';
import { cancelWorkflow, deleteWorkflow } from '~/server/services/orchestrator/workflows';
import { guardedProcedure, middleware, protectedProcedure, router } from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

const orchestratorMiddleware = middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  let token = getEncryptedCookie(ctx, generationServiceCookie.name);
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId: ctx.user.id,
    });
    setEncryptedCookie(ctx, {
      name: generationServiceCookie.name,
      maxAge: generationServiceCookie.maxAge,
      value: token,
    });
  }
  return next({ ctx: { token } });
});

const orchestratorProcedure = protectedProcedure.use(orchestratorMiddleware);
const orchestratorGuardedProcedure = guardedProcedure.use(orchestratorMiddleware);

export const orchestratorRouter = router({
  // #region [requests]
  deleteWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => deleteWorkflow({ ...input, token: ctx.token })),
  cancelWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => cancelWorkflow({ ...input, token: ctx.token })),
  // #endregion

  // #region [textToImage]
  getTextToImageRequests: orchestratorProcedure
    .input(workflowQuerySchema)
    .query(({ ctx, input }) => getTextToImageRequests({ ...input, token: ctx.token })),
  textToImageWhatIf: orchestratorProcedure
    .input(textToImageWhatIfSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(({ input, ctx }) => whatIfTextToImage({ ...input, user: ctx.user, token: ctx.token })),
  createTextToImage: orchestratorGuardedProcedure
    .input(textToImageSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createTextToImage({ ...input, user: ctx.user, token: ctx.token });
      } catch (e) {
        if (e instanceof TRPCError && e.message.startsWith('Your prompt was flagged')) {
          await reportProhibitedRequestHandler({
            input: { prompt: input.params.prompt, source: 'External' },
            ctx,
          });
        }
        throw e;
      }
    }),
  updateManyTextToImageWorkflows: orchestratorProcedure
    .input(z.object({ workflows: textToImageWorkflowUpdateSchema.array() }))
    .mutation(({ ctx, input }) => updateTextToImageWorkflow({ ...input, token: ctx.token })),
  // #endregion

  // #region [image training]

  // #endregion
});
