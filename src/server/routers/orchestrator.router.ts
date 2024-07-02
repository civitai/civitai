import { z } from 'zod';
import { workflowQuerySchema, workflowIdSchema } from './../schema/orchestrator/workflows.schema';
import {
  textToImageCreateSchema,
  textToImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  createTextToImage,
  whatIfTextToImage,
  getTextToImageRequests,
} from '~/server/services/orchestrator/textToImage/textToImage';
import { cancelWorkflow, deleteWorkflow } from '~/server/services/orchestrator/workflows';
import {
  guardedProcedure,
  middleware,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { updateWorkflowStepSchema } from '~/server/services/orchestrator/orchestrator.schema';
import { updateWorkflowSteps } from '~/server/services/orchestrator/workflowSteps';
import { createComfy } from '~/server/services/orchestrator/comfy/comfy';

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

  // #region [steps]
  steps: router({
    update: orchestratorProcedure
      .input(z.object({ data: updateWorkflowStepSchema.array() }))
      .mutation(({ ctx, input }) => updateWorkflowSteps({ input: input.data, token: ctx.token })),
  }),
  // #endregion

  // #region [image]
  createImage: orchestratorGuardedProcedure
    .input(textToImageCreateSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const args = { ...input, user: ctx.user, token: ctx.token };
        if (input.workflowKey === 'text2img') return await createTextToImage(args);
        else return await createComfy(args);
      } catch (e) {
        if (e instanceof TRPCError && e.message.startsWith('Your prompt was flagged')) {
          await reportProhibitedRequestHandler({
            input: {
              prompt: input.params.prompt,
              negativePrompt: input.params.negativePrompt,
              source: 'External',
            },
            ctx,
          });
        }
        throw e;
      }
    }),
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
    .input(textToImageCreateSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createTextToImage({ ...input, user: ctx.user, token: ctx.token });
      } catch (e) {
        if (e instanceof TRPCError && e.message.startsWith('Your prompt was flagged')) {
          await reportProhibitedRequestHandler({
            input: {
              prompt: input.params.prompt,
              negativePrompt: input.params.negativePrompt,
              source: 'External',
            },
            ctx,
          });
        }
        throw e;
      }
    }),
  // #endregion

  // #region [image training]

  // #endregion
});
