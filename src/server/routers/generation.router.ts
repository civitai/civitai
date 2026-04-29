import { getByIdSchema } from './../schema/base.schema';
import {
  checkResourcesCoverageSchema,
  getGenerationDataSchema,
  getGenerationResourcesSchema,
  getResourceDataByIdsSchema,
  resolveImageMetaSchema,
  // sendFeedbackSchema,
} from '~/server/schema/generation.schema';
import {
  checkResourcesCoverage,
  getGenerationData,
  getGenerationEcosystemConfig,
  getGenerationResources,
  getGenerationStatus,
  getGenerationConfig,
  getResourceData,
  getUnavailableResources,
  resolveImageMeta,
  setGenerationEcosystemConfig,
  setGenerationStatus,
  // textToImage,
  // textToImageTestRun,
  toggleUnavailableResource,
} from '~/server/services/generation/generation.service';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import { edgeCacheIt, purgeOnSuccess } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  getWorkflowDefinitions,
  setWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import * as z from 'zod';
import { getGenerationEngines } from '~/server/services/generation/engines';

const ecosystemConfigInputSchema = z.object({
  modOnlyEcosystems: z.array(z.string()),
  disabledEcosystems: z.array(z.string()),
  testingEcosystems: z.array(z.string()),
  experimentalEcosystems: z.array(z.string()),
  modOnlyIds: z.array(z.number().int().positive()),
  disabledIds: z.array(z.number().int().positive()),
  testingIds: z.array(z.number().int().positive()),
});

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
    .query(({ input, ctx }) =>
      getGenerationData({ query: input, user: ctx.user, sfwOnly: ctx.features.isGreen })
    ),
  checkResourcesCoverage: publicProcedure
    .input(checkResourcesCoverageSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ input }) => checkResourcesCoverage(input)),
  getStatus: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.xs, tags: () => ['generation-status'] }))
    .query(() => getGenerationStatus()),
  getStatusModerator: moderatorProcedure.query(() => getGenerationStatus()),
  setStatus: moderatorProcedure
    .input(
      z.object({
        available: z.boolean(),
        message: z.string().max(2000).nullish(),
      })
    )
    .use(purgeOnSuccess(['generation-status']))
    .mutation(({ input }) => setGenerationStatus(input)),
  getGenerationConfig: publicProcedure.query(({ ctx }) => getGenerationConfig(ctx.user ?? {})),
  getEcosystemConfig: moderatorProcedure.query(async () => {
    // Strip the per-user `hasTestingAccess` field — the moderator UI edits the
    // raw operator-set config that gets persisted to Redis.
    const { hasTestingAccess: _hasTestingAccess, ...config } = await getGenerationEcosystemConfig();
    return config;
  }),
  setEcosystemConfig: moderatorProcedure
    .input(ecosystemConfigInputSchema)
    .mutation(({ input }) => setGenerationEcosystemConfig(input)),
  getUnavailableResources: publicProcedure.query(() => getUnavailableResources()),
  toggleUnavailableResource: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      toggleUnavailableResource({ ...input, isModerator: ctx.user.isModerator })
    ),
  getResourceDataByIds: publicProcedure.input(getResourceDataByIdsSchema).query(({ input, ctx }) =>
    getResourceData(input.ids, {
      user: ctx.user,
      withPreview: true,
      sfwOnly: ctx.features.isGreen,
    })
  ),
  resolveImageMeta: publicProcedure
    .input(resolveImageMetaSchema)
    .query(({ input, ctx }) =>
      resolveImageMeta({ input, user: ctx.user, sfwOnly: ctx.features.isGreen })
    ),
});
