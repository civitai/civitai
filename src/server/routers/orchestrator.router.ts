import { deleteJob, taintJob, taintJobSchema } from '~/server/services/orchestrator/jobs';
import {
  cancelRequest,
  deleteRequest,
  getRequestsSchema,
  requestByIdSchema,
} from '~/server/services/orchestrator/requests';
import {
  getTextToImageRequests,
  textToImage,
  textToImageSchema,
} from '~/server/services/orchestrator/textToImage';
import { protectedProcedure, router } from '~/server/trpc';

export const orchestrationRouter = router({
  // #region [requests]
  deleteRequest: protectedProcedure
    .input(requestByIdSchema)
    .mutation(({ ctx, input }) => deleteRequest({ ...input, user: ctx.user })),
  cancelRequest: protectedProcedure
    .input(requestByIdSchema)
    .mutation(({ ctx, input }) => cancelRequest({ ...input, user: ctx.user })),
  // #endregion

  // #region [jobs]
  taintJob: protectedProcedure
    .input(taintJobSchema)
    .mutation(({ ctx, input }) => taintJob({ ...input, user: ctx.user })),
  deleteJob: protectedProcedure
    .input(requestByIdSchema)
    .mutation(({ ctx, input }) => deleteJob({ ...input, user: ctx.user })),
  // #endregion

  // #region [textToImage]
  getTextToImageRequests: protectedProcedure
    .input(getRequestsSchema)
    .query(({ ctx, input }) => getTextToImageRequests({ ...input, user: ctx.user })),
  createTextToImage: protectedProcedure
    .input(textToImageSchema)
    .mutation(({ ctx, input }) => textToImage({ ...input, user: ctx.user })),
  // #endregion

  // #region [image training]

  // #endregion
});
