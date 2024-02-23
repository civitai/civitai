import { getModelData } from '~/server/controllers/training.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  autoTagInput,
  createTrainingRequestSchema,
  moveAssetInput,
} from '~/server/schema/training.schema';
import {
  autoTagHandler,
  createTrainingRequest,
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
  moveAsset: protectedProcedure
    .input(moveAssetInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => moveAsset({ ...input, userId: ctx.user.id })),
  getModelBasic: publicProcedure.input(getByIdSchema).query(getModelData),
  autoTag: guardedProcedure
    .input(autoTagInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => autoTagHandler({ ...input, userId: ctx.user.id })),
});
