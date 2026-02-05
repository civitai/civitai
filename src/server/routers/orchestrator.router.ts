import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  buildGenerationContext,
  generateFromGraph,
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
import { getBaseModelGroup } from '~/shared/constants/base-model.constants';
import { EXPERIMENTAL_MODE_SUPPORTED_MODELS } from '~/shared/constants/generation.constants';
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

const orchestratorProcedure = protectedProcedure.use(orchestratorMiddleware);
const orchestratorGuardedProcedure = guardedProcedure
  .use(orchestratorMiddleware)
  .use(experimentalMiddleware);
const experimentalProcedure = protectedProcedure.use(experimentalMiddleware);

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
      const { input: formInput, civitaiTip, creatorTip, tags: inputTags, sourceMetadata, remixOfId } = input;
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


  // #region [image training]
  createTraining: orchestratorGuardedProcedure
    .input(imageTrainingRouterInputSchema)
    .mutation(async ({ ctx, input }) => {
      const args = {
        ...input,
        token: ctx.token,
        user: ctx.user,
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
});
