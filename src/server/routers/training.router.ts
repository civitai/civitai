import { createGenerationRequestSchema } from '~/server/schema/generation.schema';
import { createGenerationRequest } from '~/server/services/generation/generation.service';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const trainingRouter = router({
  createRequest: protectedProcedure
    .input(createGenerationRequestSchema)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => createGenerationRequest({ ...input, userId: ctx.user.id })),
});
