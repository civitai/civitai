import { z } from 'zod';
import { workflowQuerySchema, workflowIdSchema } from './../schema/orchestrator/workflows.schema';
import {
  generateImageSchema,
  generateImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  createTextToImage,
  createTextToImageStep,
} from '~/server/services/orchestrator/textToImage/textToImage';
import {
  cancelWorkflow,
  deleteWorkflow,
  submitWorkflow,
} from '~/server/services/orchestrator/workflows';
import { guardedProcedure, middleware, protectedProcedure, router } from '~/server/trpc';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { reportProhibitedRequestHandler } from '~/server/controllers/user.controller';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { updateWorkflowStepSchema } from '~/server/services/orchestrator/orchestrator.schema';
import { updateWorkflowSteps } from '~/server/services/orchestrator/workflowSteps';
import { createComfy, createComfyStep } from '~/server/services/orchestrator/comfy/comfy';
import dayjs from 'dayjs';
import { queryGeneratedImageWorkflows } from '~/server/services/orchestrator/common';
import { generatorFeedbackReward } from '~/server/rewards';
import { logToAxiom } from '~/server/logging/client';
import { ComfyStepTemplate, TextToImageStepTemplate } from '@civitai/client';

const orchestratorMiddleware = middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  let token = getEncryptedCookie(ctx, generationServiceCookie.name);
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId: ctx.user.id,
    });
    setEncryptedCookie(ctx, {
      name: generationServiceCookie.name,
      maxAge: generationServiceCookie.maxAge,
      value: token,
    });
  }
  return next({ ctx: { token } });
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
  steps: router({
    update: orchestratorProcedure
      .input(
        z.object({
          data: updateWorkflowStepSchema.array(),
          updateType: z.enum(['feedback']).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.updateType === 'feedback') {
          await Promise.all(
            input.data.map(async (data) =>
              Object.entries(data.metadata.images)
                .filter(([, x]) => (x as any).feedback)
                .map(([key]) =>
                  generatorFeedbackReward.apply({
                    userId: ctx.user.id,
                    jobId: key,
                  })
                )
            )
          );
        }
        await updateWorkflowSteps({
          input: input.data,
          token: ctx.token,
        });
      }),
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
        if (input.params.workflow === 'txt2img') return await createTextToImage(args);
        else return await createComfy(args);
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
  generateImageWhatIf: orchestratorGuardedProcedure
    .input(generateImageWhatIfSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(async ({ ctx, input }) => {
      try {
        const args = {
          ...input,
          resources: input.resources.map((id) => ({ id, strength: 1 })),
          user: ctx.user,
          token: ctx.token,
        };

        let step: TextToImageStepTemplate | ComfyStepTemplate;
        if (args.params.workflow === 'txt2img') step = await createTextToImageStep(args);
        else step = await createComfyStep(args);

        const workflow = await submitWorkflow({
          token: args.token,
          body: {
            steps: [step],
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
        logToAxiom({ name: 'generate-image-what-if', type: 'error', payload: input, error: e });
        throw e;
      }
    }),
  // #endregion

  // #region [image training]

  // #endregion
});
