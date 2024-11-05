import dayjs from 'dayjs';
import { string } from 'zod';
import { env } from '~/env/server.mjs';
import { generation } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { GenerationSchema } from '~/server/schema/orchestrator/orchestrator.schema';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import { createWorkflowStep } from '~/server/services/orchestrator/orchestrator.service';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { auditPrompt } from '~/utils/metadata/audit';
import { getRandomInt } from '~/utils/number-helpers';

type Ctx = { token: string; userId: number };

export async function generate({
  token,
  userId,
  civitaiTip,
  creatorTip,
  tags = [],
  ...args
}: GenerationSchema & Ctx) {
  // throw throwBadRequestError(`Your prompt was flagged for: `);
  if ('prompt' in args.data) {
    try {
      const { blockedFor, success } = auditPrompt(args.data.prompt);
      if (!success) throw { blockedFor, type: 'regex' };

      const { flagged, categories } = await extModeration
        .moderatePrompt(args.data.prompt)
        .catch((error) => {
          logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
          return { flagged: false, categories: [] as string[] };
        });
      if (flagged) throw { blockedFor: categories, type: 'external' };
    } catch (e) {
      const error = e as { blockedFor: string[]; type: string };
      throw throwBadRequestError(`Your prompt was flagged: ${error.blockedFor.join(', ')}`);
    }
  }

  if (!('seed' in args.data))
    args.data = { ...args.data, seed: getRandomInt(1, generation.maxValues.seed) };

  const step = await createWorkflowStep(args as GenerationSchema);

  const workflow = await submitWorkflow({
    token: token,
    body: {
      tags: [WORKFLOW_TAGS.GENERATION, ...tags],
      steps: [step],
      tips: {
        civitai: civitaiTip,
        creators: creatorTip,
      },
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${userId}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  });

  const [formatted] = await formatGenerationResponse([workflow]);
  return formatted;
}

export async function whatIf(args: GenerationSchema & Ctx) {
  const step = await createWorkflowStep(args);

  const workflow = await submitWorkflow({
    token: args.token,
    body: { steps: [step] },
    query: { whatif: true },
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
}
