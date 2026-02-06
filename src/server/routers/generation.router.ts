import { getByIdSchema } from './../schema/base.schema';
import {
  checkResourcesCoverageSchema,
  getGenerationDataSchema,
  getGenerationResourcesSchema,
  getResourceDataByIdsSchema,
  // sendFeedbackSchema,
} from '~/server/schema/generation.schema';
import {
  checkResourcesCoverage,
  getGenerationData,
  getGenerationResources,
  getGenerationStatus,
  getResourceData,
  getUnavailableResources,
  getUnstableResources,
  // textToImage,
  // textToImageTestRun,
  toggleUnavailableResource,
} from '~/server/services/generation/generation.service';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  getWorkflowDefinitions,
  setWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import * as z from 'zod';
import { getGenerationEngines } from '~/server/services/generation/engines';

export const generationRouter = router({
  getGenerationEngines: publicProcedure.query(() => getGenerationEngines()),
  getWorkflowDefinitions: publicProcedure.query(({ ctx }) =>
    getWorkflowDefinitions().then((res) =>
      res
        .filter((x) => {
          if (x.status === 'disabled') return false;
          if (x.status === 'mod-only' && !ctx.user?.isModerator) return false;
          return true;
        })
        .map(({ template, ...rest }) => rest)
    )
  ),
  setWorkflowDefinition: moderatorProcedure
    .input(z.any())
    .mutation(({ input }) => setWorkflowDefinition(input.key, input)),
  getResources: publicProcedure
    .input(getGenerationResourcesSchema)
    .query(({ ctx, input }) => getGenerationResources({ ...input, user: ctx.user })),
  getGenerationData: publicProcedure
    .input(getGenerationDataSchema)
    .query(({ input, ctx }) => getGenerationData({ query: input, user: ctx.user })),
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
  getResourceDataByIds: publicProcedure
    .input(getResourceDataByIdsSchema)
    .query(({ input, ctx }) => getResourceData(input.ids, ctx.user)),
});
