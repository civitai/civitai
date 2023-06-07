import { getByIdSchema } from './../schema/base.schema';
import {
  createGenerationRequestSchema,
  getGenerationRequestsSchema,
  getGenerationResourcesSchema,
} from '~/server/schema/generation.schema';

import {
  createGenerationRequest,
  getGenerationRequests,
  getGenerationResource,
  getGenerationResources,
} from '~/server/services/generation/generation.service';
import {
  guardedProcedure,
  middleware,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

export const generationRouter = router({
  getResource: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getGenerationResource(input)),
  getResources: publicProcedure
    .input(getGenerationResourcesSchema)
    .query(({ ctx, input }) => getGenerationResources({ ...input, user: ctx.user })),
  getRequests: protectedProcedure
    .input(getGenerationRequestsSchema)
    .query(({ input, ctx }) => getGenerationRequests({ ...input, userId: ctx.user.id })),
  createRequest: protectedProcedure
    .input(createGenerationRequestSchema)
    .mutation(({ input, ctx }) => createGenerationRequest({ ...input, userId: ctx.user.id })),
});
