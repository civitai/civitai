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
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';

export const orchestratorRouter = router({
  // #region [requests]
  deleteWorkflow: protectedProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => deleteWorkflow({ ...input, user: ctx.user })),
  cancelWorkflow: protectedProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => cancelWorkflow({ ...input, user: ctx.user })),
  // #endregion

  // #region [textToImage]
  getTextToImageRequests: protectedProcedure
    .input(workflowQuerySchema)
    .query(({ ctx, input }) => getTextToImageRequests({ ...input, user: ctx.user })),
  textToImageWhatIf: protectedProcedure
    .input(textToImageWhatIfSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(({ input, ctx }) => whatIfTextToImage({ ...input, user: ctx.user })),
  createTextToImage: guardedProcedure.input(textToImageSchema).mutation(async ({ ctx, input }) => {
    try {
      await createTextToImage({ ...input, user: ctx.user });
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
  updateManyTextToImageWorkflows: protectedProcedure
    .input(z.object({ workflows: textToImageWorkflowUpdateSchema.array() }))
    .mutation(({ ctx, input }) => updateTextToImageWorkflow({ ...input, user: ctx.user })),
  // #endregion

  // #region [image training]

  // #endregion
});
