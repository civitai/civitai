import { createTrainingRequestSchema } from '~/server/schema/training.schema';
import { createTrainingRequest } from '~/server/services/training.service';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const trainingRouter = router({
  createRequest: protectedProcedure
    .input(createTrainingRequestSchema)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => createTrainingRequest({ ...input, userId: ctx.user.id })),
});
