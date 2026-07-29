import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  buildGenerationContext,
  bustQueriedWorkflowsCache,
  formatGenerationResponse2,
  generateFromGraph,
  getWorkflowStatusUpdate,
  queryGeneratedImageWorkflows2,
  updateWorkflow,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflow as clientGetWorkflow } from '@civitai/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  logToAxiom,
  classifyErrorFault,
  buildServerFaultErrorLog,
  markServerFaultLogged,
} from '~/server/logging/client';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { generatorFeedbackReward } from '~/server/rewards';
import { generationStatusDefaultMessage } from '~/server/schema/generation.schema';
import {
  imageTrainingRouterInputSchema,
  imageTrainingRouterWhatIfSchema,
} from '~/server/schema/orchestrator/training.schema';
import {
  patchSchema,
  workflowIdSchema,
  workflowQuerySchema,
  workflowUpdateSchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { getExperimentalFlags } from '~/server/services/orchestrator/experimental';
import { imageUpload } from '~/server/services/orchestrator/imageUpload';
import {
  createTrainingWhatIfWorkflow,
  createTrainingWorkflow,
} from '~/server/services/orchestrator/training/training.orch';
import {
  cancelWorkflow,
  deleteManyWorkflows,
  deleteWorkflow,
  getWorkflow,
  patchWorkflows,
  patchWorkflowTags,
  queryWorkflows,
} from '~/server/services/orchestrator/workflows';
import { enhancePrompt } from '~/server/services/orchestrator/promptEnhancement';
import { promptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { getRequiredFeatureFlagForWorkflow } from '~/shared/data-graph/generation/config/workflows';
import { patchWorkflowSteps } from '~/server/services/orchestrator/workflowSteps';
import {
  guardedProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { regionProxyMiddleware } from '~/server/orchestrator/region-proxy.middleware';
import { pollIterationWorkflow } from '~/server/services/orchestrator/poll-iteration';
import {
  getPresetModelConfig,
  pickAspectRatioSize,
  submitPresetImageGen,
  whatIfPresetImageGen,
} from '~/server/services/orchestrator/preset-image-gen.service';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
import type { SessionUser } from '~/types/session';
import { reviewConsumerStrikes } from '../http/orchestrator/flagged-consumers';
import semver from 'semver';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { getAllowedAccountTypes } from '../utils/buzz-helpers';
import { getVideoMetadata } from '~/server/services/orchestrator/videoEnhancement';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Resolves the currencies to use for a generation request.
 * If the user selected a specific buzz type, validates it's allowed and uses only that type.
 * Otherwise falls back to all allowed types for the domain.
 */
function resolveGenerationCurrencies(
  features: Parameters<typeof getAllowedAccountTypes>[0],
  userBuzzType?: string
): BuzzSpendType[] {
  const allowed = getAllowedAccountTypes(features, ['blue']);
  if (userBuzzType && allowed.includes(userBuzzType as BuzzSpendType)) {
    return [userBuzzType as BuzzSpendType];
  }
  return allowed;
}

const orchestratorMiddleware = middleware(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!user) throw throwAuthorizationError();
  const token = await getOrchestratorToken(user.id, ctx);
  const allowMatureContent = ctx.domain === 'green' || !user.showNsfw ? false : undefined;
  return next({
    ctx: {
      ...ctx,
      user,
      token,
      allowMatureContent,
      hideMatureContent: ctx.domain === 'green' || !user.showNsfw,
    },
  });
  // return next({ ctx: { ...ctx, user, token, allowMatureContent: ctx.features.isBlue } });
});

const experimentalMiddleware = middleware(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!user) throw throwAuthorizationError();

  const flags = await getExperimentalFlags(user);

  // `enhancedCompatibilitySdcpp` forces experimental on — it requires the
  // experimental path in the orchestrator regardless of the Flipt flag.
  if (ctx.features?.enhancedCompatibilitySdcpp) flags.experimental = true;

  return next({ ctx: { ...ctx, user, ...flags } });
});

const enforceGenerationVersion = middleware(async ({ ctx, next }) => {
  const result = await next();
  const version = ctx.req?.headers['x-client-version'] as string;
  if (!version || version === 'unknown') return result;

  // Fail open: this middleware runs on every generation tRPC call. A
  // sysRedis outage would otherwise 500 every gen request — defeating
  // the rest of the generation-path fail-open coverage in this PR.
  let genClient: Record<string, string>;
  try {
    // Wall-clock deadline so a silent sysRedis half-open can't park every gen
    // tRPC call ~11min (a fast DOWN already rejects into the catch below).
    genClient = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.CLIENT));
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'enforceGenerationVersion', err);
    return result;
  }

  const genVersion = decodeRedisString(genClient.version);
  if (genVersion && semver.lt(version, genVersion)) {
    ctx.res?.setHeader('x-generation-update-required', genVersion);
    if (genClient.notes)
      ctx.res?.setHeader('x-generation-update-notes', decodeRedisString(genClient.notes));
  }

  return result;
});

const orchestratorProcedure = protectedProcedure
  .use(orchestratorMiddleware)
  .use(enforceGenerationVersion)
  .use(regionProxyMiddleware);
const orchestratorGuardedProcedure = guardedProcedure
  .use(orchestratorMiddleware)
  .use(experimentalMiddleware)
  .use(enforceGenerationVersion)
  .use(regionProxyMiddleware);
const experimentalProcedure = protectedProcedure.use(experimentalMiddleware);

// The iterative editor's default preset model. The model registry itself lives
// in `preset-image-gen.service.ts` (shared with comics + the enqueued-panels job).
const DEFAULT_ITERATE_MODEL = 'NanoBanana';

export const orchestratorRouter = router({
  getVideoMetadata: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ videoUrl: z.string() }))
    .query(({ ctx, input }) => getVideoMetadata(input)),

  // #region [prompt enhancement]
  enhancePrompt: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(promptEnhancementSchema)
    .mutation(({ ctx, input }) =>
      enhancePrompt({
        input,
        token: ctx.token,
        userId: ctx.user.id,
        isGreen: ctx.domain === 'green',
        isModerator: ctx.user.isModerator,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
      })
    ),
  /** Generic workflow query by tags — used for prompt enhancement history, future text workflows, etc. */
  queryWorkflowsByTags: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(workflowQuerySchema)
    .query(async ({ ctx, input }) => {
      return queryWorkflows({
        ...input,
        token: ctx.token,
        hideMatureContent: ctx.hideMatureContent,
      });
    }),
  getWorkflow: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(workflowIdSchema)
    .query(({ ctx, input }) =>
      getWorkflow({ token: ctx.token, path: { workflowId: input.workflowId } })
    ),
  // #endregion

  // #region [requests]
  deleteWorkflow: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(workflowIdSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await deleteWorkflow({ ...input, token: ctx.token });
      // Bust the short-TTL queryGeneratedImages cache so a reconnect/invalidate
      // refetch within the TTL doesn't resurrect the just-deleted workflow.
      // ctx.token is ctx.user's own token (orchestratorMiddleware), so the
      // owning user is ctx.user.id. Fire-and-forget — see generateFromGraph.
      bustQueriedWorkflowsCache(ctx.user.id).catch(() => null);
      return result;
    }),
  cancelWorkflow: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(workflowIdSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await cancelWorkflow({ ...input, token: ctx.token });
      // Bust so a refetch within the TTL doesn't show the cancelled workflow
      // back in a non-cancelled state. Owner is ctx.user.id (own token).
      bustQueriedWorkflowsCache(ctx.user.id).catch(() => null);
      return result;
    }),
  updateWorkflow: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(workflowUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await updateWorkflow({ ...input, token: ctx.token });
      // Bust so a refetch within the TTL doesn't revert the update. Owner is
      // ctx.user.id (own token).
      bustQueriedWorkflowsCache(ctx.user.id).catch(() => null);
      return result;
    }),
  // #endregion

  // #region [steps]
  patch: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(patchSchema)
    .mutation(async ({ ctx, input: { workflows, steps, tags, remove } }) => {
      // const toUpdate: { workflowId: string; patches: JsonPatchOperation[] }[] = [];
      // if (!!steps?.length) {
      //   for (const step of steps) {
      //     toUpdate.push({
      //       workflowId: step.workflowId,
      //       patches: step.patches.map((patch) => ({
      //         ...patch,
      //         path: `/step/${step.stepName}/metadata/${patch.path}`,
      //       })),
      //     });
      //   }
      // }
      const { ip, user } = ctx;

      if (!!workflows?.length) await patchWorkflows({ input: workflows, token: ctx.token });

      // if (!!toUpdate.length) await patchWorkflows({ input: toUpdate, token: ctx.token });
      if (!!remove?.length) await deleteManyWorkflows({ workflowIds: remove, token: ctx.token });
      if (!!tags?.length) await patchWorkflowTags({ input: tags, token: ctx.token });
      if (!!steps?.length) {
        await patchWorkflowSteps({
          input: steps.map((step) => ({
            ...step,
            patches: step.patches.map((patch) => ({ ...patch, path: `/metadata${patch.path}` })),
          })),
          token: ctx.token,
        });
        await Promise.all(
          steps.map((step) =>
            Object.values(step.patches)
              // todo - add clickhouse tracking for user feedback/favorites
              .filter((patch) => patch.path.includes('feedback'))
              .map(async ({ op, path }) => {
                if (op === 'add') {
                  const parts = (path as string).split('/');
                  const jobId = parts[parts.length - 2];
                  await generatorFeedbackReward.apply(
                    {
                      userId: user.id,
                      jobId,
                    },
                    { ip }
                  );
                }
              })
          )
        );
      }

      // Bust the short-TTL queryGeneratedImages cache if this patch changed
      // anything the feed renders (workflow patch, removal, tag change, or the
      // step-metadata update behind useUpdateImageStepMetadata). Without this, a
      // reconnect/invalidate refetch within the TTL reverts the optimistic
      // client patch / resurrects a removed item. ctx.token is ctx.user's own
      // token, so the owner is ctx.user.id. Fire-and-forget.
      if (workflows?.length || remove?.length || tags?.length || steps?.length) {
        bustQueriedWorkflowsCache(user.id).catch(() => null);
      }
    }),
  // #endregion

  // #region [generated images]
  queryGeneratedImages: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(workflowQuerySchema)
    .query(({ ctx, input }) =>
      queryGeneratedImageWorkflows2({
        ...input,
        token: ctx.token,
        user: ctx.user,
        tags: ctx.domain === 'green' ? [...input.tags, 'green'] : input.tags,
        hideMatureContent: ctx.hideMatureContent,
        // Self-serve feed: token belongs to ctx.user, so the per-user cache is safe.
        cache: true,
      })
    ),
  // #region [Generation Graph V2 endpoints]
  /**
   * Generate from graph - unified endpoint for all generation types
   */
  generateFromGraph: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.any())
    .mutation(async ({ ctx, input }) => {
      const {
        input: formInput,
        civitaiTip,
        creatorTip,
        tags: inputTags,
        sourceMetadata,
        sourceMetadataMap,
        remixOfId,
        buzzType,
        externalId,
      } = input;
      const tags = ctx.domain === 'green' ? ['green', ...(inputTags ?? [])] : inputTags ?? [];
      const userTier = ctx.user.tier ?? 'free';
      const { externalCtx, status } = await buildGenerationContext(userTier, ctx.features, {
        id: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });

      // Workflow-level feature-flag gate. `filterWorkflowsByFeatureFlags` only
      // hides the option in the picker UI — a crafted submission payload would
      // otherwise reach the dispatcher unchecked. Mirrors the client filter
      // server-side so e.g. `txt2model3d` / `img2model3d` (gated on
      // `model3dGenerator`) is rejected for users who don't have the flag.
      const generateRequiredFlag = getRequiredFeatureFlagForWorkflow(
        formInput?.workflow as string | undefined
      );
      if (
        generateRequiredFlag &&
        (ctx.features as Record<string, boolean | undefined>)[generateRequiredFlag] !== true
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This workflow is not available for your account.',
        });
      }

      // Check generation status early
      if (status.mode === 'disabled' && !ctx.user.isModerator) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: status.message ?? generationStatusDefaultMessage,
        });
      }
      if (status.mode === 'memberOnly' && userTier === 'free' && !ctx.user.isModerator) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: status.message ?? generationStatusDefaultMessage,
        });
      }

      const result = await generateFromGraph({
        input: formInput,
        externalCtx,
        userId: ctx.user.id,
        token: ctx.token,
        experimental: ctx.experimental,
        isGreen: ctx.features.isGreen,
        allowMatureContent: ctx.allowMatureContent,
        currencies: resolveGenerationCurrencies(ctx.features, buzzType),
        isModerator: ctx.user.isModerator,
        track: ctx.track,
        civitaiTip,
        creatorTip,
        tags,
        sourceMetadata,
        sourceMetadataMap,
        remixOfId,
        externalId,
      });

      // Bust the short-TTL queryGeneratedImages cache so a concurrent tab or an
      // immediate signal reconnect sees the just-submitted workflow without
      // waiting out the TTL. Fire-and-forget: the response must not block on a
      // cache eviction, and a failed bust only falls back to the short TTL.
      bustQueriedWorkflowsCache(ctx.user.id).catch(() => null);

      return result;
    }),

  /**
   * What-if from graph - cost estimation for generation-graph inputs
   */
  whatIfFromGraph: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.any())
    .query(async ({ ctx, input }) => {
      const userTier = ctx.user.tier ?? 'free';
      const { externalCtx, status } = await buildGenerationContext(userTier, ctx.features, {
        id: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });

      // Mirror of the gate in `generateFromGraph`. Reject what-if costing for
      // flag-gated workflows the user can't reach so we don't leak pricing
      // for hidden generation modes.
      const whatIfRequiredFlag = getRequiredFeatureFlagForWorkflow(
        (input as { workflow?: string } | undefined)?.workflow
      );
      if (
        whatIfRequiredFlag &&
        (ctx.features as Record<string, boolean | undefined>)[whatIfRequiredFlag] !== true
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This workflow is not available for your account.',
        });
      }

      if (status.mode === 'disabled' && !ctx.user.isModerator) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: status.message ?? generationStatusDefaultMessage,
        });
      }
      if (status.mode === 'memberOnly' && userTier === 'free' && !ctx.user.isModerator) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: status.message ?? generationStatusDefaultMessage,
        });
      }

      try {
        return await whatIfFromGraph({
          input,
          externalCtx,
          userId: ctx.user.id,
          isModerator: ctx.user.isModerator,
          token: ctx.token,
          experimental: ctx.experimental,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (e) {
        // ~94% of failures here are EXPECTED client-fault validation (BAD_REQUEST
        // et al. — "resources not available for generation", "request is invalid")
        // for a non-critical cost PREVIEW. Logging those at error severity made
        // this the single largest error-by-name entry in prod and buried the real
        // ~6% server faults. Branch on the TRPCError code:
        //  - client fault → log at 'info' (normal user feedback, not an incident);
        //  - server fault → log at 'error' WITH the un-masked underlying cause
        //    (errorHandling.ts replaces the message with a generic string but keeps
        //    the original on `.cause`), so the real 500s stay diagnosable.
        // Behavior is otherwise unchanged: the client still receives the original
        // 400/500 because we always re-throw `e`.
        if (classifyErrorFault(e) === 'client') {
          logToAxiom({
            name: 'what-if-from-graph',
            type: 'info',
            payload: input,
            error: e instanceof TRPCError ? { code: e.code, name: e.name, message: e.message } : e,
          }).catch();
        } else {
          logToAxiom({
            name: 'what-if-from-graph',
            type: 'error',
            payload: input,
            error: buildServerFaultErrorLog(e),
          }).catch();
        }
        // Mark so the central chokepoint (tRPC onError) doesn't log this same fault
        // a second time — this router already emitted the un-masked structured log
        // (with the extra `payload: input` context) above.
        markServerFaultLogged(e);
        throw e;
      }
    }),
  // #endregion

  // #region [Image upload]
  imageUpload: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ sourceImage: z.string() }))
    .mutation(({ ctx, input }) =>
      imageUpload({ token: ctx.token, allowMatureContent: ctx.allowMatureContent, ...input })
    ),
  // #endregion

  // #region [image training]
  createTraining: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(imageTrainingRouterInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { buzzType, ...rest } = input;
      const args = {
        ...rest,
        token: ctx.token,
        user: ctx.user,
        features: ctx.features,
        currencies: resolveGenerationCurrencies(ctx.features, buzzType),
      };
      return await createTrainingWorkflow(args);
    }),
  createTrainingWhatif: orchestratorProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(imageTrainingRouterWhatIfSchema)
    .query(async ({ ctx, input }) => {
      const args = {
        ...input,
        token: ctx.token,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
      };
      return await createTrainingWhatIfWorkflow(args);
    }),
  // #endregion

  // #region [moderator]
  /** Query another user's generated images (moderator only) */
  queryUserGeneratedImages: moderatorProcedure
    .input(workflowQuerySchema.extend({ userId: z.number() }))
    .query(async ({ ctx, input }) => {
      const { userId, ...query } = input;
      // Get token for the target user, not the moderator. bypassCache=true:
      // this is a cross-user mint — populating the per-pod cache with the
      // TARGET user's token off a MODERATOR session would leave 60s of
      // recoverable per-target-user state on every pod a moderator touched.
      // See orchestrator-token-cache.ts docstring (Round-5 audit H2).
      const targetToken = await getOrchestratorToken(userId, ctx, { bypassCache: true });
      return queryGeneratedImageWorkflows2({
        ...query,
        token: targetToken,
        user: ctx.user,
        hideMatureContent: false, // Moderators should see all content
      });
    }),

  /** Fetch any workflow by ID and normalize it (moderator only) */
  getWorkflowForModeration: moderatorProcedure
    .input(workflowIdSchema)
    .query(async ({ ctx, input }) => {
      const { data } = await clientGetWorkflow({
        client: internalOrchestratorClient,
        path: { workflowId: input.workflowId },
      });
      if (!data) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' });
      const [normalized] = await formatGenerationResponse2([data], ctx.user);
      return normalized;
    }),

  reviewConsumerStrikes: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .mutation(({ input, ctx }) =>
      reviewConsumerStrikes({ consumerId: `civitai-${input.userId}`, moderatorId: ctx.user.id })
    ),
  statusUpdate: orchestratorGuardedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(workflowIdSchema)
    .query(({ ctx, input }) =>
      getWorkflowStatusUpdate({ token: ctx.token, workflowId: input.workflowId })
    ),

  // ── Generic iterative image editor endpoints ──

  iterateGenerate: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        enhance: z.boolean().default(true),
        aspectRatio: z.string().default('3:4'),
        baseModel: z.string().nullish(),
        quantity: z.number().int().min(1).max(4).default(1),
        sourceImageUrl: z.string().optional(),
        sourceImageWidth: z.number().int().positive().optional(),
        sourceImageHeight: z.number().int().positive().optional(),
        referenceImages: z
          .array(
            z.object({
              url: z.string(),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const modelConfig = getPresetModelConfig(input.baseModel, DEFAULT_ITERATE_MODEL);
      const effectiveVersionId =
        input.sourceImageUrl && modelConfig.img2imgVersionId
          ? modelConfig.img2imgVersionId
          : modelConfig.versionId;

      // Dimensions are returned to the client for the iteration UI; the graph
      // derives the submitted dimensions from the aspect-ratio string.
      const { width: panelWidth, height: panelHeight } = pickAspectRatioSize(
        input.aspectRatio,
        modelConfig.sizes
      );

      const token = await getOrchestratorToken(ctx.user!.id, ctx);

      // Build prompt — optionally enhance
      const originalPrompt = input.prompt.trim();
      let fullPrompt = originalPrompt;
      if (input.enhance && fullPrompt) {
        fullPrompt = await enhanceComicPrompt({
          token,
          userPrompt: fullPrompt,
          characterName: '',
          characterNames: [],
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      }

      // Build images array
      const allImages: { url: string; width: number; height: number }[] = [];
      if (input.sourceImageUrl && input.sourceImageWidth && input.sourceImageHeight) {
        const sourceEdgeUrl = getEdgeUrl(input.sourceImageUrl, { original: true });
        allImages.push({
          url: sourceEdgeUrl,
          width: input.sourceImageWidth,
          height: input.sourceImageHeight,
        });
      }
      if (input.referenceImages) {
        for (const ref of input.referenceImages) {
          const refEdgeUrl = getEdgeUrl(ref.url, { original: true });
          allImages.push({ url: refEdgeUrl, width: ref.width, height: ref.height });
        }
      }

      const result = await submitPresetImageGen({
        prompt: fullPrompt || undefined,
        aspectRatio: input.aspectRatio,
        quantity: input.quantity,
        images: allImages,
        modelConfig,
        versionIdOverride: effectiveVersionId,
        user: ctx.user! as SessionUser,
        token,
        flags: ctx.features,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        tags: ctx.domain === 'green' ? ['iterate', 'green'] : ['iterate'],
        isGreen: ctx.features.isGreen,
        allowMatureContent: ctx.domain === 'green' ? false : undefined,
        track: ctx.track,
      });

      return {
        workflowId: result.id,
        width: panelWidth,
        height: panelHeight,
        cost: result.cost?.total ?? 0,
        enhancedPrompt: input.enhance && fullPrompt !== originalPrompt ? fullPrompt : null,
      };
    }),

  getIterateCostEstimate: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(
      z.object({
        baseModel: z.string().nullish(),
        aspectRatio: z.string().default('3:4'),
        quantity: z.number().int().min(1).max(4).default(1),
        sourceImage: z
          .object({
            url: z.string(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .nullish(),
        referenceImages: z
          .array(
            z.object({
              url: z.string(),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
          )
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const token = await getOrchestratorToken(ctx.user!.id, ctx);
        const modelConfig = getPresetModelConfig(input.baseModel, DEFAULT_ITERATE_MODEL);
        const effectiveVersionId =
          input.sourceImage && modelConfig.img2imgVersionId
            ? modelConfig.img2imgVersionId
            : modelConfig.versionId;

        // Build real images array for accurate pricing
        const images: { url: string; width: number; height: number }[] = [];
        if (input.sourceImage) {
          const sourceEdgeUrl = getEdgeUrl(input.sourceImage.url, { original: true });
          images.push({
            url: sourceEdgeUrl,
            width: input.sourceImage.width,
            height: input.sourceImage.height,
          });
        }
        if (input.referenceImages) {
          for (const ref of input.referenceImages) {
            const refEdgeUrl = getEdgeUrl(ref.url, { original: true });
            images.push({ url: refEdgeUrl, width: ref.width, height: ref.height });
          }
        }

        return await whatIfPresetImageGen({
          aspectRatio: input.aspectRatio,
          quantity: input.quantity,
          images,
          modelConfig,
          versionIdOverride: effectiveVersionId,
          user: ctx.user! as SessionUser,
          token,
          flags: ctx.features,
          currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        });
      } catch (error) {
        console.error('Orchestrator getIterateCostEstimate failed:', error);
        return { cost: 0, ready: false };
      }
    }),

  pollIterationStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(
      z.object({
        workflowId: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        prompt: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return pollIterationWorkflow({
        workflowId: input.workflowId,
        width: input.width,
        height: input.height,
        prompt: input.prompt,
        userId: ctx.user!.id,
        ctx,
      });
    }),
});
