import { CacheTTL } from '~/server/common/constants';
import type { RateLimit } from '~/server/middleware.trpc';
import { rateLimit } from '~/server/middleware.trpc';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  requestServiceDealAttachmentSchema,
  requestServiceDealUploadSchema,
  serviceDealFileActionSchema,
  serviceDealFilesSchema,
} from '~/server/schema/creator-service-deal.schema';
import {
  completeServiceDealAttachment,
  completeServiceDealUpload,
  deleteServiceDealAttachment,
  deleteServiceDealFile,
  deliverServiceDeal,
  listServiceDealFiles,
  requestServiceDealAttachment,
  requestServiceDealUpload,
} from '~/server/services/creator-service-deal-file.service';

/**
 * Putting files into a deal is behind `creatorServices`. Reading them is not, and neither is the
 * download route: with the flag off a buyer must still reach files they have paid for.
 */
const gated = guardedProcedure.use(isFlagProtected('creatorServices'));
const attachGated = gated.use(isFlagProtected('creatorServicesAttachments'));

/**
 * Per user, across deals. The per-deal file cap counts only files still attached, so removing one
 * frees its place; this bounds how often a place can be refilled.
 */
export const serviceDealAttachmentRateLimits: RateLimit[] = [
  { limit: 30, period: CacheTTL.hour },
  { limit: 100, period: CacheTTL.day },
];

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
  requestAttachment: attachGated
    .use(rateLimit(serviceDealAttachmentRateLimits))
    .input(requestServiceDealAttachmentSchema)
    .mutation(({ input, ctx }) =>
      requestServiceDealAttachment({
        dealId: input.dealId,
        userId: ctx.user.id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.size,
        rightsAttested: input.rightsAttested,
        likenessAttested: input.likenessAttested,
      })
    ),
  completeAttachment: attachGated
    .input(serviceDealFileActionSchema)
    .mutation(({ input, ctx }) =>
      completeServiceDealAttachment({ fileId: input.fileId, userId: ctx.user.id })
    ),
  deleteAttachment: attachGated
    .input(serviceDealFileActionSchema)
    .mutation(({ input, ctx }) =>
      deleteServiceDealAttachment({ fileId: input.fileId, userId: ctx.user.id })
    ),
  list: protectedProcedure.input(serviceDealFilesSchema).query(({ input, ctx }) =>
    listServiceDealFiles({
      dealId: input.dealId,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
      canReviewCsam: !!ctx.features?.csamReports,
    })
  ),
});
