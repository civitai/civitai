import { ComfyStepTemplate, TextToImageStepTemplate } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import dayjs from 'dayjs';
import { z } from 'zod';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import {
  generate,
  handleGetPriorityVolume,
  whatIf,
} from '~/server/controllers/orchestrator.controller';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';
import { logToAxiom } from '~/server/logging/client';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  generationSchema,
  requestPrioritySchema,
} from '~/server/orchestrator/generation/generation.schema';
import { REDIS_KEYS, sysRedis } from '~/server/redis/client';
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
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { createComfy, createComfyStep } from '~/server/services/orchestrator/comfy/comfy';
import { queryGeneratedImageWorkflows } from '~/server/services/orchestrator/common';
import { imageUpload } from '~/server/services/orchestrator/imageUpload';
import {
  createTextToImage,
  createTextToImageStep,
} from '~/server/services/orchestrator/textToImage/textToImage';
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
import { guardedProcedure, middleware, protectedProcedure, router } from '~/server/trpc';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

const TOKEN_STORE: 'redis' | 'cookie' = false ? 'cookie' : 'redis';
const orchestratorMiddleware = middleware(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!user) throw throwAuthorizationError();
  const redisKey = user.id.toString();
  let token: string | null =
    TOKEN_STORE === 'redis'
      ? await sysRedis.hGet(REDIS_KEYS.GENERATION.TOKENS, redisKey).then((x) => x ?? null)
      : getEncryptedCookie(ctx, generationServiceCookie.name);
  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId: user.id,
    });
    if (TOKEN_STORE === 'redis') {
      await Promise.all([
        sysRedis.hSet(REDIS_KEYS.GENERATION.TOKENS, redisKey, token),
        sysRedis.hExpire(REDIS_KEYS.GENERATION.TOKENS, redisKey, generationServiceCookie.maxAge),
      ]);
    } else
      setEncryptedCookie(ctx, {
        name: generationServiceCookie.name,
        maxAge: generationServiceCookie.maxAge,
        value: token,
      });
  }
  return next({ ctx: { ...ctx, user, token } });
});

const orchestratorProcedure = protectedProcedure.use(orchestratorMiddleware);
const orchestratorGuardedProcedure = guardedProcedure.use(orchestratorMiddleware);
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
  queryGeneratedImages: orchestratorProcedure
    .input(workflowQuerySchema)
    .query(({ ctx, input }) => queryGeneratedImageWorkflows({ ...input, token: ctx.token })),
  generateImage: orchestratorGuardedProcedure
    .input(generateImageSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const args = { ...input, user: ctx.user, token: ctx.token };
        if (input.params.workflow === 'txt2img') return await createTextToImage({ ...args });
        else return await createComfy({ ...args });
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
          resources: input.resources.map((id) => ({ id, strength: 1 })),
          user: ctx.user,
          token: ctx.token,
        };

        let step: TextToImageStepTemplate | ComfyStepTemplate;
        if (args.params.workflow === 'txt2img')
          step = await createTextToImageStep({ ...args, whatIf: true });
        else step = await createComfyStep({ ...args, whatIf: true });

        const workflow = await submitWorkflow({
          token: args.token,
          body: {
            steps: [step],
            tips: args.tips,
            experimental: env.ORCHESTRATOR_EXPERIMENTAL,
          },
          query: {
            whatif: true,
          },
        });

        let ready = true,
          eta = dayjs().add(10, 'minutes').toDate(),
          position = 0;

        for (const step of workflow.steps ?? []) {
          for (const job of step.jobs ?? []) {
            const { queuePosition } = job;
            if (!queuePosition) continue;

            const { precedingJobs, startAt, support } = queuePosition;
            if (support !== 'available' && ready) ready = false;
            if (precedingJobs && precedingJobs < position) {
              position = precedingJobs;
              if (startAt && new Date(startAt).getTime() < eta.getTime()) eta = new Date(startAt);
            }
          }
        }



        return {
          cost: workflow.cost,
          ready,
          eta,
          position,
        };
      } catch (e) {
        logToAxiom({
          name: 'generate-image-what-if',
          type: 'error',
          payload: input,
          error: e,
        }).catch();
        throw e;
      }
    }),
  whatIf: orchestratorGuardedProcedure
    .input(generationSchema)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(({ ctx, input }) => whatIf({ ...input, userId: ctx.user.id, token: ctx.token })),
  generate: orchestratorGuardedProcedure
    .input(z.any())
    .mutation(({ ctx, input }) => generate({ ...input, userId: ctx.user.id, token: ctx.token })),
  requestPriority: orchestratorGuardedProcedure
    .input(requestPrioritySchema)
    .use(edgeCacheIt({ ttl: 5 }))
    .query(({ input }) => handleGetPriorityVolume({ type: input.type })),
  // #endregion

  // #region [Image upload]
  imageUpload: orchestratorGuardedProcedure
    .input(z.object({ sourceImage: z.string() }))
    .mutation(({ ctx, input }) => imageUpload({ token: ctx.token, ...input })),
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
});
