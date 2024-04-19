import { getByIdSchema } from './../schema/base.schema';
import {
  bulkDeleteGeneratedImagesSchema,
  checkResourcesCoverageSchema,
  createGenerationRequestSchema,
  generationRequestTestRunSchema,
  getGenerationRequestsSchema,
  getGenerationResourcesSchema,
  sendFeedbackSchema,
} from '~/server/schema/generation.schema';
import {
  bulkDeleteGeneratedImages,
  checkResourcesCoverage,
  createGenerationRequest,
  deleteAllGenerationRequests,
  deleteGenerationRequest,
  getGenerationRequests,
  getGenerationResources,
  getGenerationStatus,
  getUnavailableResources,
  getUnstableResources,
  sendGenerationFeedback,
  textToImage,
  textToImageTestRun,
  toggleUnavailableResource,
} from '~/server/services/generation/generation.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';

export const generationRouter = router({
  // #region [requests related]
  getRequests: protectedProcedure
    .input(getGenerationRequestsSchema)
    .use(isFlagProtected('imageGeneration'))
    .query(({ input, ctx }) => getGenerationRequests({ ...input, userId: ctx.user.id })),
  createRequest: guardedProcedure
    .input(createGenerationRequestSchema)
    .use(isFlagProtected('imageGeneration'))
    .mutation(async ({ input, ctx }) => {
      try {
        return await createGenerationRequest({
          ...input,
          userId: ctx.user.id,
          userTier: ctx.user.tier,
          isModerator: ctx.user.isModerator,
        });
      } catch (e) {
        // Handle prohibited prompt
        if (
          e instanceof TRPCError &&
          e.code === 'BAD_REQUEST' &&
          e.message.startsWith('Your prompt was flagged')
        ) {
          await reportProhibitedRequestHandler({
            input: { prompt: input.params.prompt, source: 'External' },
            ctx,
          });
        }
        throw e;
      }
    }),
  deleteRequest: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('imageGeneration'))
    .mutation(({ input, ctx }) => deleteGenerationRequest({ ...input, userId: ctx.user.id })),
  bulkDeleteImages: protectedProcedure
    .input(bulkDeleteGeneratedImagesSchema)
    .use(isFlagProtected('imageGeneration'))
    .mutation(({ input, ctx }) => bulkDeleteGeneratedImages({ ...input, userId: ctx.user.id })),
  deleteAllRequests: protectedProcedure.mutation(({ ctx }) =>
    deleteAllGenerationRequests({ userId: ctx.user.id })
  ),
  // #endregion
  getResources: publicProcedure
    .input(getGenerationResourcesSchema)
    .query(({ ctx, input }) => getGenerationResources({ ...input, user: ctx.user })),
  checkResourcesCoverage: publicProcedure
    .input(checkResourcesCoverageSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ input }) => checkResourcesCoverage(input)),
  getStatus: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getGenerationStatus()),
  getUnstableResources: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getUnstableResources()),
  getUnavailableResources: publicProcedure.query(() => getUnavailableResources()),
  toggleUnavailableResource: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      toggleUnavailableResource({ ...input, isModerator: ctx.user.isModerator })
    ),
  sendFeedback: protectedProcedure
    .input(sendFeedbackSchema)
    .mutation(({ input, ctx }) =>
      sendGenerationFeedback({ ...input, userId: ctx.user.id, ip: ctx.ip })
    ),
  textToImage: protectedProcedure
    .input(createGenerationRequestSchema)
    .mutation(({ input, ctx }) => {
      return textToImage({
        input: {
          ...input,
          userId: ctx.user.id,
        },
      });
    }),
  estimateTextToImage: publicProcedure
    .input(generationRequestTestRunSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(({ input }) => textToImageTestRun(input)),
});
