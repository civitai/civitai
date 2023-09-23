import { getModelData } from '~/server/controllers/training.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { createTrainingRequestSchema, moveAssetInput } from '~/server/schema/training.schema';
import { createTrainingRequest, moveAsset } from '~/server/services/training.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const trainingRouter = router({
  createRequest: protectedProcedure
    .input(createTrainingRequestSchema)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => createTrainingRequest({ ...input, userId: ctx.user.id })),
  moveAsset: protectedProcedure
    .input(moveAssetInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input }) => moveAsset(input)),
  getModelBasic: publicProcedure.input(getByIdSchema).query(getModelData),
});
