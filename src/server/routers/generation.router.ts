import { getByIdSchema } from './../schema/base.schema';
import {
  checkResourcesCoverageSchema,
  createGenerationRequestSchema,
  getGenerationRequestsSchema,
  getGenerationResourcesSchema,
} from '~/server/schema/generation.schema';
import {
  checkResourcesCoverage,
  createGenerationRequest,
  deleteGenerationRequest,
  getGenerationRequests,
  getGenerationResource,
  getGenerationResources,
  getImageGenerationData,
} from '~/server/services/generation/generation.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const generationRouter = router({
  getResource: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getGenerationResource(input)),
  getResources: publicProcedure
    .input(getGenerationResourcesSchema)
    .query(({ ctx, input }) => getGenerationResources({ ...input, user: ctx.user })),
  getRequests: protectedProcedure
    .input(getGenerationRequestsSchema)
    .use(isFlagProtected('imageGeneration'))
    .query(({ input, ctx }) => getGenerationRequests({ ...input, userId: ctx.user.id })),
  createRequest: protectedProcedure
    .input(createGenerationRequestSchema)
    .use(isFlagProtected('imageGeneration'))
    .mutation(({ input, ctx }) => createGenerationRequest({ ...input, userId: ctx.user.id })),
  deleteRequest: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('imageGeneration'))
    .mutation(({ input, ctx }) => deleteGenerationRequest({ ...input, userId: ctx.user.id })),
  getImageGenerationData: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('imageGeneration'))
    .query(({ input, ctx }) => getImageGenerationData({ ...input })),
  checkResourcesCoverage: publicProcedure
    .input(checkResourcesCoverageSchema)
    .query(({ input }) => checkResourcesCoverage(input)),
});
