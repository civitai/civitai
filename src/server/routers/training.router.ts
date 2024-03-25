import { CacheTTL } from '~/server/common/constants';
import { getModelData } from '~/server/controllers/training.controller';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  autoTagInput,
  createTrainingRequestDryRunSchema,
  createTrainingRequestSchema,
  moveAssetInput,
} from '~/server/schema/training.schema';
import {
  autoTagHandler,
  createTrainingRequest,
  createTrainingRequestDryRun,
  getJobEstStartsHandler,
  getTrainingServiceStatus,
  moveAsset,
} from '~/server/services/training.service';
import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

export const trainingRouter = router({
  createRequest: guardedProcedure
    .input(createTrainingRequestSchema)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => createTrainingRequest({ ...input, userId: ctx.user.id })),
  createRequestDryRun: protectedProcedure
    .input(createTrainingRequestDryRunSchema)
    .use(isFlagProtected('imageTraining'))
    .query(({ input }) => createTrainingRequestDryRun({ ...input })),
  moveAsset: protectedProcedure
    .input(moveAssetInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => moveAsset({ ...input, userId: ctx.user.id })),
  getModelBasic: publicProcedure.input(getByIdSchema).query(getModelData),
  autoTag: guardedProcedure
    .input(autoTagInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => autoTagHandler({ ...input, userId: ctx.user.id })),
  getStatus: publicProcedure
    .use(isFlagProtected('imageTraining'))
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getTrainingServiceStatus()),
  getJobEstStarts: protectedProcedure
    .use(isFlagProtected('imageTraining'))
    .query(({ ctx }) => getJobEstStartsHandler({ userId: ctx.user.id })),
});
