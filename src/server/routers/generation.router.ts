import { gateRuleSchema } from '~/shared/data-graph/generation/gates';
import { getByIdSchema } from './../schema/base.schema';
import {
  checkResourcesCoverageSchema,
  generationEcosystemConfigSchema,
  generationStatusModeSchema,
  getGenerationDataSchema,
  getResourceDataByIdsSchema,
  resolveImageMetaSchema,
  resolveWildcardPackSchema,
  // sendFeedbackSchema,
} from '~/server/schema/generation.schema';
import {
  checkResourcesCoverage,
  getGenerationData,
  getGenerationEcosystemConfig,
  getGenerationStatus,
  getGateRules,
  getGenerationConfig,
  getResourceData,
  resolveImageMeta,
  setGateRules,
  setGenerationEcosystemConfig,
  setGenerationStatus,
  setSelfHostedGenerationStatus,
  // textToImage,
  // textToImageTestRun,
  toggleGenerationDisabled,
} from '~/server/services/generation/generation.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { edgeCacheIt, purgeOnSuccess, rateLimit } from '~/server/middleware.trpc';
import { resolveWildcardPackForUser } from '~/server/services/wildcard-pack.service';
import { CacheTTL } from '~/server/common/constants';
import {
  getWorkflowDefinitions,
  setWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import * as z from 'zod';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const generationRouter = router({
  getWorkflowDefinitions: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(({ ctx }) =>
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
  getGenerationData: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(getGenerationDataSchema)
    .query(({ input, ctx }) =>
      getGenerationData({ query: input, user: ctx.user, sfwOnly: ctx.features.isGreen })
    ),
  checkResourcesCoverage: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(checkResourcesCoverageSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ input }) => checkResourcesCoverage(input)),
  getStatus: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .use(edgeCacheIt({ ttl: CacheTTL.xs, tags: () => ['generation-status'] }))
    .query(async () => {
      // Don't expose the moderator-identity audit stamps on the public,
      // edge-cached endpoint — they're moderator-only (getStatusModerator).
      const { updatedBy, selfHostedUpdatedBy, ...status } = await getGenerationStatus();

      // Only surface the status message to clients while the gate is actually
      // engaged. The message stays persisted in Redis (so operators don't have
      // to re-enter it when toggling), but a stale/irrelevant message isn't
      // returned while the mode is 'enabled'. getStatusModerator still returns
      // the raw stored message so the mod UI can see/edit it.
      if (status.mode === 'enabled') status.message = null;
      return status;
    }),
  getStatusModerator: moderatorProcedure.query(() => getGenerationStatus()),
  setStatus: moderatorProcedure
    .input(
      z.object({
        mode: generationStatusModeSchema,
        message: z.string().max(2000).nullish(),
      })
    )
    .use(purgeOnSuccess(['generation-status']))
    .mutation(({ input, ctx }) =>
      setGenerationStatus({
        mode: input.mode,
        message: input.message,
        updatedBy: { id: ctx.user.id, username: ctx.user.username ?? 'unknown' },
      })
    ),
  setSelfHostedStatus: moderatorProcedure
    .input(z.object({ mode: generationStatusModeSchema }))
    .use(purgeOnSuccess(['generation-status']))
    .mutation(({ input, ctx }) =>
      setSelfHostedGenerationStatus({
        mode: input.mode,
        updatedBy: { id: ctx.user.id, username: ctx.user.username ?? 'unknown' },
      })
    ),
  getGenerationConfig: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(({ ctx }) =>
      getGenerationConfig({
        id: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
        tier: ctx.user?.tier,
      })
    ),
  getEcosystemConfig: moderatorProcedure.query(async () => {
    // Strip the runtime-only `hasTestingAccess` — the moderator UI edits the raw
    // operator-set config (just `experimentalEcosystems`) persisted to Redis.
    const { hasTestingAccess: _hasTestingAccess, ...config } = await getGenerationEcosystemConfig();
    return config;
  }),
  setEcosystemConfig: moderatorProcedure
    .input(generationEcosystemConfigSchema)
    .mutation(({ input }) => setGenerationEcosystemConfig(input)),
  getGateRules: moderatorProcedure.query(() => getGateRules()),
  setGateRules: moderatorProcedure
    .input(z.array(gateRuleSchema))
    .mutation(({ input }) => setGateRules(input)),
  toggleGenerationDisabled: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      toggleGenerationDisabled({ ...input, isModerator: ctx.user.isModerator })
    ),
  getResourceDataByIds: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(getResourceDataByIdsSchema)
    .query(({ input, ctx }) =>
      getResourceData(input.ids, {
        user: ctx.user,
        withPreview: true,
        sfwOnly: ctx.features.isGreen,
      })
    ),
  resolveImageMeta: publicProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(resolveImageMetaSchema)
    .query(({ input, ctx }) =>
      resolveImageMeta({ input, user: ctx.user, sfwOnly: ctx.features.isGreen })
    ),
  // App Blocks wildcard-pack import (W13) — the SESSION-authed resolve step for
  // the page-host message bridge. A page block posts GET_WILDCARD_PACK to the
  // PageBlockHost, which calls this with the viewer's real session, then fetches
  // + unzips the returned signed URL CLIENT-SIDE (bytes never touch a web pod).
  //
  // A MUTATION deliberately (not a query, though it reads): the response carries
  // a short-lived signed download URL, which a `.query` would leak into the
  // `?input=…` cache key / URL / Referer where it's replayable within its TTL —
  // the same reasoning as blocks.getMyBuzzBalance. Gating + maturity live in
  // resolveWildcardPackForUser (all download-gate refusals → NOT_FOUND; a pack
  // above the viewer's maturity ceiling → FORBIDDEN).
  resolveWildcardPack: protectedProcedure
    .use(
      rateLimit({
        // A gated file-resolve reachable per block-import click. Bound the rate
        // so a page block can't hammer the delivery-worker signing path.
        limit: 30,
        period: 60,
        errorMessage: 'Too many wildcard-pack requests — slow down.',
      })
    )
    .input(resolveWildcardPackSchema)
    .mutation(({ input, ctx }) =>
      resolveWildcardPackForUser({
        modelVersionId: input.modelVersionId,
        user: ctx.user,
        canViewNsfw: ctx.features.canViewNsfw,
      })
    ),
});
