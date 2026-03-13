import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  buildGenerationContext,
  generateFromGraph,
  getWorkflowStatusUpdate,
  queryGeneratedImageWorkflows2,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';
import { logToAxiom } from '~/server/logging/client';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { generatorFeedbackReward } from '~/server/rewards';
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
import { updateWorkflow } from '~/server/services/orchestrator/common';
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
  patchWorkflows,
  patchWorkflowTags,
  submitWorkflow,
} from '~/server/services/orchestrator/workflows';
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
import { pollIterationWorkflow } from '~/server/services/orchestrator/poll-iteration';
import { createImageGen, createImageGenStep } from '~/server/services/orchestrator/imageGen/imageGen';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
import {
  commonAspectRatios,
  nanoBananaProSizes,
  seedreamSizes,
  qwenSizes,
  grokSizes,
} from '~/server/common/constants';
import type { SessionUser } from 'next-auth';
import {
  getFlagged,
  getReasons,
  getConsumerStrikes,
  reviewConsumerStrikes,
} from '../http/orchestrator/flagged-consumers';
import {
  getFlaggedConsumersSchema,
  getFlaggedReasonsSchema,
  getFlaggedConsumerStrikesSchema,
} from '~/server/schema/orchestrator/flagged-consumers.schema';
import semver from 'semver';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getAllowedAccountTypes } from '../utils/buzz-helpers';
import { getVideoMetadata } from '~/server/services/orchestrator/videoEnhancement';

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

  const flags = await getExperimentalFlags({
    userId: user.id,
    isModerator: user.isModerator,
    isMember: user.tier != null && user.tier !== 'free',
  });

  return next({ ctx: { ...ctx, user, ...flags } });
});

const enforceGenerationVersion = middleware(async ({ ctx, next }) => {
  const result = await next();
  const version = ctx.req?.headers['x-client-version'] as string;
  if (!version || version === 'unknown') return result;

  const [genClient, genClientTemp] = await Promise.all([
    sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.CLIENT),
    sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.CLIENT_TEMP),
  ]);

  // New implementation: generation-panel-specific modal with notes
  if (genClient.version && semver.lt(version, genClient.version)) {
    ctx.res?.setHeader('x-generation-update-required', genClient.version);
    if (genClient.notes) ctx.res?.setHeader('x-generation-update-notes', genClient.notes);
  }

  // Legacy fallback: global modal (deprecated after rollout)
  if (genClientTemp.version && semver.lt(version, genClientTemp.version)) {
    ctx.res?.setHeader('x-update-required', 'true');
  }

  return result;
});

const orchestratorProcedure = protectedProcedure
  .use(orchestratorMiddleware)
  .use(enforceGenerationVersion);
const orchestratorGuardedProcedure = guardedProcedure
  .use(orchestratorMiddleware)
  .use(experimentalMiddleware)
  .use(enforceGenerationVersion);
const experimentalProcedure = protectedProcedure.use(experimentalMiddleware);

// Model config for generic iterative generation (mirrors comics config)
const ITERATE_MODEL_CONFIG: Record<
  string,
  {
    engine: string;
    baseModel: string;
    versionId: number;
    img2imgVersionId?: number;
    maxReferenceImages: number;
    sizes: { label: string; width: number; height: number }[];
  }
> = {
  NanoBanana: {
    engine: 'gemini',
    baseModel: 'NanoBanana',
    versionId: 2436219,
    maxReferenceImages: 7,
    sizes: nanoBananaProSizes,
  },
  Flux2: {
    engine: 'flux2',
    baseModel: 'Flux.2 D',
    versionId: 2439067,
    maxReferenceImages: 7,
    sizes: commonAspectRatios,
  },
  Seedream: {
    engine: 'seedream',
    baseModel: 'Seedream',
    versionId: 2470991,
    maxReferenceImages: 7,
    sizes: seedreamSizes,
  },
  OpenAI: {
    engine: 'openai',
    baseModel: 'OpenAI',
    versionId: 2512167,
    maxReferenceImages: 7,
    sizes: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '3:2', width: 1536, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
    ],
  },
  Qwen: {
    engine: 'qwen',
    baseModel: 'Qwen',
    versionId: 2552908,
    img2imgVersionId: 2558804,
    maxReferenceImages: 3,
    sizes: qwenSizes,
  },
  Grok: {
    engine: 'grok',
    baseModel: 'Grok',
    versionId: 2738377,
    maxReferenceImages: 7,
    sizes: grokSizes,
  },
};

export const orchestratorRouter = router({
  getVideoMetadata: orchestratorProcedure
    .input(z.object({ videoUrl: z.string() }))
    .query(({ ctx, input }) => getVideoMetadata(input)),

  // #region [requests]
  deleteWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => deleteWorkflow({ ...input, token: ctx.token })),
  cancelWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => cancelWorkflow({ ...input, token: ctx.token })),
  updateWorkflow: orchestratorProcedure
    .input(workflowUpdateSchema)
    .mutation(({ ctx, input }) => updateWorkflow({ ...input, token: ctx.token })),
  // #endregion

  // #region [steps]
  patch: orchestratorProcedure
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
      const { ip, fingerprint, user } = ctx;

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
                    { ip, fingerprint }
                  );
                }
              })
          )
        );
      }
    }),
  // #endregion

  // #region [generated images]
  queryGeneratedImages: orchestratorProcedure.input(workflowQuerySchema).query(({ ctx, input }) =>
    queryGeneratedImageWorkflows2({
      ...input,
      token: ctx.token,
      user: ctx.user,
      tags: ctx.domain === 'green' ? [...input.tags, 'green'] : input.tags,
      hideMatureContent: ctx.hideMatureContent,
    })
  ),
  // #region [Generation Graph V2 endpoints]
  /**
   * Generate from graph - unified endpoint for all generation types
   */
  generateFromGraph: orchestratorGuardedProcedure
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
      } = input;
      const tags = ctx.domain === 'green' ? ['green', ...(inputTags ?? [])] : inputTags ?? [];
      const userTier = ctx.user.tier ?? 'free';
      const { externalCtx, status } = await buildGenerationContext(userTier);

      // Check generation status early
      if (!status.available && !ctx.user.isModerator) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: status.message ?? 'Generation is currently disabled',
        });
      }

      return generateFromGraph({
        input: formInput,
        externalCtx,
        userId: ctx.user.id,
        token: ctx.token,
        experimental: ctx.experimental,
        isGreen: ctx.features.isGreen,
        allowMatureContent: ctx.allowMatureContent,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
        isModerator: ctx.user.isModerator,
        track: ctx.track,
        civitaiTip,
        creatorTip,
        tags,
        sourceMetadata,
        sourceMetadataMap,
        remixOfId,
      });
    }),

  /**
   * What-if from graph - cost estimation for generation-graph inputs
   */
  whatIfFromGraph: orchestratorGuardedProcedure.input(z.any()).query(async ({ ctx, input }) => {
    const userTier = ctx.user.tier ?? 'free';
    const { externalCtx, status } = await buildGenerationContext(userTier);

    if (!status.available && !ctx.user.isModerator) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: status.message ?? 'Generation is currently disabled',
      });
    }

    try {
      return await whatIfFromGraph({
        input,
        externalCtx,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
        token: ctx.token,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
      });
    } catch (e) {
      logToAxiom({
        name: 'what-if-from-graph',
        type: 'error',
        payload: input,
        error:
          e instanceof TRPCError
            ? {
                code: e.code,
                name: e.name,
                message: e.message,
              }
            : e,
      }).catch();
      throw e;
    }
  }),
  // #endregion

  // #region [Image upload]
  imageUpload: orchestratorGuardedProcedure
    .input(z.object({ sourceImage: z.string() }))
    .mutation(({ ctx, input }) =>
      imageUpload({ token: ctx.token, allowMatureContent: ctx.allowMatureContent, ...input })
    ),
  // #endregion

  // #region [image training]
  createTraining: orchestratorGuardedProcedure
    .input(imageTrainingRouterInputSchema)
    .mutation(async ({ ctx, input }) => {
      const args = {
        ...input,
        token: ctx.token,
        user: ctx.user,
        features: ctx.features,
        currencies: getAllowedAccountTypes(ctx.features, ['blue']),
      };
      return await createTrainingWorkflow(args);
    }),
  createTrainingWhatif: orchestratorProcedure
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
      // Get token for the target user, not the moderator
      const targetToken = await getOrchestratorToken(userId, ctx);
      return queryGeneratedImageWorkflows2({
        ...query,
        token: targetToken,
        user: ctx.user,
        hideMatureContent: false, // Moderators should see all content
      });
    }),

  getFlaggedConsumers: moderatorProcedure
    .input(getFlaggedConsumersSchema)
    .query(({ input }) => getFlagged(input)),
  getFlaggedReasons: moderatorProcedure
    .input(getFlaggedReasonsSchema)
    .query(({ input }) => getReasons(input)),
  getFlaggedConsumerStrikes: moderatorProcedure
    .input(getFlaggedConsumerStrikesSchema)
    .query(({ input }) => getConsumerStrikes(input)),
  reviewConsumerStrikes: moderatorProcedure
    .input(z.object({ userId: z.number() }))
    .mutation(({ input, ctx }) =>
      reviewConsumerStrikes({ consumerId: `civitai-${input.userId}`, moderatorId: ctx.user.id })
    ),
  statusUpdate: orchestratorGuardedProcedure
    .input(workflowIdSchema)
    .query(({ ctx, input }) =>
      getWorkflowStatusUpdate({ token: ctx.token, workflowId: input.workflowId })
    ),

  // ── Generic iterative image editor endpoints ──

  iterateGenerate: protectedProcedure
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
      const modelConfig =
        ITERATE_MODEL_CONFIG[input.baseModel ?? 'NanoBanana'] ??
        ITERATE_MODEL_CONFIG.NanoBanana;
      const effectiveVersionId =
        input.sourceImageUrl && modelConfig.img2imgVersionId
          ? modelConfig.img2imgVersionId
          : modelConfig.versionId;

      const sizes = modelConfig.sizes;
      const match =
        sizes.find((s) => s.label === input.aspectRatio) ??
        sizes.find((s) => s.label === '3:4' || s.label === 'Portrait') ??
        sizes[0];
      const { width: panelWidth, height: panelHeight } = match;

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

      const cappedImages =
        allImages.length <= modelConfig.maxReferenceImages
          ? allImages
          : allImages.slice(0, modelConfig.maxReferenceImages);

      const result = await createImageGen({
        params: {
          prompt: fullPrompt || '',
          negativePrompt: '',
          engine: modelConfig.engine,
          baseModel: modelConfig.baseModel as any,
          width: panelWidth,
          height: panelHeight,
          aspectRatio: input.aspectRatio,
          workflow: 'txt2img',
          sampler: 'Euler',
          steps: 25,
          quantity: input.quantity,
          draft: false,
          disablePoi: false,
          priority: 'low',
          sourceImage: null,
          images: cappedImages,
        },
        resources: [{ id: effectiveVersionId, strength: 1 }],
        tags: ['iterate'],
        tips: { creators: 0, civitai: 0 },
        user: ctx.user! as SessionUser,
        token,
        currencies: ['yellow'],
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
        const modelConfig =
          ITERATE_MODEL_CONFIG[input.baseModel ?? 'NanoBanana'] ??
          ITERATE_MODEL_CONFIG.NanoBanana;
        const hasSourceImage = !!input.sourceImage;
        const effectiveVersionId =
          hasSourceImage && modelConfig.img2imgVersionId
            ? modelConfig.img2imgVersionId
            : modelConfig.versionId;
        const sizes = modelConfig.sizes;
        const match =
          sizes.find((s) => s.label === input.aspectRatio) ??
          sizes.find((s) => s.label === '3:4' || s.label === 'Portrait') ??
          sizes[0];
        const { width, height } = match;

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
        const cappedImages =
          images.length <= modelConfig.maxReferenceImages
            ? images
            : images.slice(0, modelConfig.maxReferenceImages);

        const step = await createImageGenStep({
          params: {
            prompt: '',
            negativePrompt: '',
            engine: modelConfig.engine,
            baseModel: modelConfig.baseModel as any,
            width,
            height,
            aspectRatio: input.aspectRatio,
            workflow: 'txt2img',
            sampler: 'Euler',
            steps: 25,
            quantity: input.quantity,
            draft: false,
            disablePoi: false,
            priority: 'low',
            sourceImage: null,
            images: cappedImages,
          },
          resources: [{ id: effectiveVersionId, strength: 1 }],
          tags: ['iterate'],
          tips: { creators: 0, civitai: 0 },
          whatIf: true,
          user: ctx.user! as SessionUser,
        });

        const workflow = await submitWorkflow({
          token,
          body: { steps: [step], currencies: ['yellow'] },
          query: { whatif: true },
        });

        return { cost: workflow.cost?.total ?? 0, ready: true };
      } catch (error) {
        console.error('Orchestrator getIterateCostEstimate failed:', error);
        return { cost: 0, ready: false };
      }
    }),

  pollIterationStatus: protectedProcedure
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
