import { workflowQuerySchema, workflowIdSchema } from './../schema/orchestrator/workflows.schema';
import {
  textToImageSchema,
  textToImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { deleteJob, taintJob, taintJobSchema } from '~/server/services/orchestrator/jobs';
import {
  createTextToImage,
  whatIfTextToImage,
  getTextToImageRequests,
  textToImage,
} from '~/server/services/orchestrator/textToImage';
import { cancelWorkflow, deleteWorkflow } from '~/server/services/orchestrator/workflows';
import { protectedProcedure, router } from '~/server/trpc';

export const orchestratorRouter = router({
  // #region [requests]
  deleteWorkflow: protectedProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => deleteWorkflow({ ...input, user: ctx.user })),
  cancelWorkflow: protectedProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => cancelWorkflow({ ...input, user: ctx.user })),
  // #endregion

  // #region [jobs]
  // taintJob: protectedProcedure
  //   .input(taintJobSchema)
  //   .mutation(({ ctx, input }) => taintJob({ ...input, user: ctx.user })),
  // deleteJob: protectedProcedure
  //   .input(requestByIdSchema)
  //   .mutation(({ ctx, input }) => deleteJob({ ...input, user: ctx.user })),
  // #endregion

  // #region [textToImage]
  getTextToImageRequests: protectedProcedure
    .input(workflowQuerySchema)
    .query(({ ctx, input }) => getTextToImageRequests({ ...input, user: ctx.user })),
  textToImageWhatIf: protectedProcedure
    .input(textToImageWhatIfSchema)
    .query(({ input, ctx }) => whatIfTextToImage({ ...input, user: ctx.user })),
  createTextToImage: protectedProcedure
    .input(textToImageSchema)
    .mutation(({ ctx, input }) => createTextToImage({ ...input, user: ctx.user })),
  // #endregion

  // #region [image training]

  // #endregion
});
