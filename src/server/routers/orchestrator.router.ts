import type {
  ComfyStepTemplate,
  ImageGenStepTemplate,
  TextToImageStepTemplate,
} from '@civitai/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { generate, whatIf } from '~/server/controllers/orchestrator.controller';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';
import { logToAxiom } from '~/server/logging/client';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { generationSchema } from '~/server/orchestrator/generation/generation.schema';
import { generatorFeedbackReward } from '~/server/rewards';
import {
  generateImageSchema,
  generateImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  imageTrainingRouterInputSchema,
  imageTrainingRouterWhatIfSchema,
} from '~/server/schema/orchestrator/training.schema';
import {
  patchSchema,
  workflowIdSchema,
  workflowQuerySchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { reportProhibitedRequestSchema } from '~/server/schema/user.schema';
import { createComfy, createComfyStep } from '~/server/services/orchestrator/comfy/comfy';
import { queryGeneratedImageWorkflows } from '~/server/services/orchestrator/common';
import { getExperimentalFlags } from '~/server/services/orchestrator/experimental';
import { imageUpload } from '~/server/services/orchestrator/imageUpload';
import {
  createTextToImage,
  createTextToImageStep,
} from '~/server/services/orchestrator/textToImage/textToImage';
import {
  createImageGen,
  createImageGenStep,
} from '~/server/services/orchestrator/imageGen/imageGen';
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

const orchestratorMiddleware = middleware(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!user) throw throwAuthorizationError();
  const token = await getOrchestratorToken(user.id, ctx);
  return next({ ctx: { ...ctx, user, token, allowMatureContent: true } });
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
  // #region [requests]
  deleteWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => deleteWorkflow({ ...input, token: ctx.token })),
  cancelWorkflow: orchestratorProcedure
    .input(workflowIdSchema)
    .mutation(({ ctx, input }) => cancelWorkflow({ ...input, token: ctx.token })),
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
    queryGeneratedImageWorkflows({
      ...input,
      token: ctx.token,
      user: ctx.user,
      allowMatureContent: ctx.allowMatureContent,
    })
  ),
  generateImage: orchestratorGuardedProcedure
    .input(generateImageSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const args = {
          ...input,
          user: ctx.user,
          token: ctx.token,
          experimental: ctx.experimental,
          batchAll: ctx.batchAll,
          // isGreen: ctx.features.isGreen,
          allowMatureContent: ctx.allowMatureContent,
        };
        // if ('sourceImage' in args.params && args.params.sourceImage) {
        //   const blobId = args.params.sourceImage.url.split('/').reverse()[0];
        //   const { nsfwLevel } = await getBlobData({ token: ctx.token, blobId });
        //   args.params.nsfw = !!nsfwLevel && nsfwNsfwLevels.includes(nsfwLevel);
        // }
        // TODO - handle createImageGen
        if (input.params.engine && input.params.engine !== 'flux-pro-raw') {
          return await createImageGen(args);
        } else if (input.params.workflow === 'txt2img') {
          return await createTextToImage({ ...args });
        } else {
          return await createComfy({ ...args });
        }
      } catch (e) {
        if (e instanceof TRPCError && e.message.startsWith('Your prompt was flagged')) {
          await reportProhibitedRequestHandler({
            input: {
              prompt: input.params.prompt,
              negativePrompt: input.params.negativePrompt,
              source: 'External',
            },
            ctx,
          });
        }
        throw e;
      }
    }),
  getImageWhatIf: orchestratorGuardedProcedure
    .input(generateImageWhatIfSchema)
    // can't use edge cache due to values dependent on individual users
    // .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(async ({ ctx, input }) => {
      try {
        const args = {
          ...input,
          resources: input.resources.map((x) => ({ ...x, strength: 1 })),
          user: ctx.user,
          token: ctx.token,
          batchAll: ctx.batchAll,
          allowMatureContent: ctx.allowMatureContent,
        };

        let step: TextToImageStepTemplate | ComfyStepTemplate | ImageGenStepTemplate;
        if (args.params.engine && args.params.engine !== 'flux-pro-raw') {
          step = await createImageGenStep({ ...args, whatIf: true });
        } else if (args.params.workflow === 'txt2img') {
          step = await createTextToImageStep({ ...args, whatIf: true });
        } else {
          step = await createComfyStep({ ...args, whatIf: true });
        }

        const workflow = await submitWorkflow({
          token: args.token,
          body: {
            steps: [step],
            tips: args.tips,
            experimental: ctx.experimental,
          },
          query: {
            whatif: true,
          },
        });

        let ready = true;

        for (const step of workflow.steps ?? []) {
          for (const job of step.jobs ?? []) {
            const { queuePosition } = job;
            if (!queuePosition) continue;

            const { support } = queuePosition;
            if (support !== 'available' && ready) ready = false;
          }
        }

        return {
          cost: workflow.cost,
          ready,
        };
      } catch (e) {
        logToAxiom({
          name: 'generate-image-what-if',
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
  whatIf: orchestratorGuardedProcedure
    .input(generationSchema)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(({ ctx, input }) =>
      whatIf({
        ...input,
        userId: ctx.user.id,
        token: ctx.token,
        experimental: ctx.experimental,
        allowMatureContent: ctx.allowMatureContent,
      })
    ),
  generate: orchestratorGuardedProcedure.input(z.any()).mutation(({ ctx, input }) =>
    generate({
      ...input,
      userId: ctx.user.id,
      token: ctx.token,
      experimental: ctx.experimental,
      // isGreen: ctx.features.isGreen,
      allowMatureContent: ctx.allowMatureContent,
    })
  ),
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
      const args = { ...input, token: ctx.token, user: ctx.user };
      return await createTrainingWorkflow(args);
    }),
  createTrainingWhatif: orchestratorProcedure
    .input(imageTrainingRouterWhatIfSchema)
    .query(async ({ ctx, input }) => {
      const args = { ...input, token: ctx.token };
      return await createTrainingWhatIfWorkflow(args);
    }),
  // #endregion

  reportProhibitedRequest: experimentalProcedure
    .input(reportProhibitedRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.testing) return false;
      return await reportProhibitedRequestHandler({ ctx, input });
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
