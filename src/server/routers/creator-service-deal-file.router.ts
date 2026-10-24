import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  requestServiceDealUploadSchema,
  serviceDealFileActionSchema,
  serviceDealFilesSchema,
} from '~/server/schema/creator-service-deal.schema';
import {
  completeServiceDealUpload,
  deleteServiceDealFile,
  deliverServiceDeal,
  listServiceDealFiles,
  requestServiceDealUpload,
} from '~/server/services/creator-service-deal-file.service';

/**
 * Putting files into a deal is behind `creatorServices`. Reading them is not, and neither is the
 * download route: with the flag off a buyer must still reach files they have paid for.
 */
const gated = guardedProcedure.use(isFlagProtected('creatorServices'));

export const creatorServiceDealFileRouter = router({
  requestUpload: gated
    .input(requestServiceDealUploadSchema)
    .mutation(({ input, ctx }) => requestServiceDealUpload({ ...input, userId: ctx.user.id })),
  completeUpload: gated
    .input(serviceDealFileActionSchema)
    .mutation(({ input, ctx }) =>
      completeServiceDealUpload({ fileId: input.fileId, userId: ctx.user.id })
    ),
  deleteFile: gated
    .input(serviceDealFileActionSchema)
    .mutation(({ input, ctx }) =>
      deleteServiceDealFile({ fileId: input.fileId, userId: ctx.user.id })
    ),
  deliver: gated
    .input(serviceDealFilesSchema)
    .mutation(({ input, ctx }) =>
      deliverServiceDeal({ dealId: input.dealId, userId: ctx.user.id })
    ),
  list: protectedProcedure.input(serviceDealFilesSchema).query(({ input, ctx }) =>
    listServiceDealFiles({
      dealId: input.dealId,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    })
  ),
});
