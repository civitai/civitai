import { NsfwLevel } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { getGenerationTags } from '~/server/orchestrator/generation/generation.schema';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import { createWorkflowStep } from '~/server/services/orchestrator/orchestrator.service';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

type Ctx = {
  token: string;
  userId: number;
  experimental?: boolean;
  allowMatureContent?: boolean;
  currencies?: BuzzSpendType[];
};

export async function generate({
  token,
  userId,
  civitaiTip = 0,
  creatorTip = 0,
  tags = [],
  experimental,
  allowMatureContent,
  isGreen,
  isModerator,
  track,
  currencies,
  ...args
}: GenerationSchema & Ctx & { isGreen?: boolean; isModerator?: boolean; track?: any }) {
  // Audit prompt if present
  if ('prompt' in args.data) {
    const negativePrompt =
      'negativePrompt' in args.data ? (args.data.negativePrompt as string) : undefined;

    await auditPromptServer({
      prompt: args.data.prompt,
      negativePrompt,
      userId,
      isGreen: !!isGreen,
      isModerator,
      track,
    });
  }

  if (!('seed' in args.data) || !args.data.seed)
    args.data = { ...args.data, seed: getRandomInt(1, maxRandomSeed) } as any;

  const step = await createWorkflowStep(args as GenerationSchema);

  const workflow = await submitWorkflow({
    token: token,
    body: {
      tags: [...new Set([...getGenerationTags(args), ...tags].filter(isDefined))],
      steps: [step],
      tips: {
        civitai: civitaiTip,
        creators: creatorTip,
      },
      experimental,
      callbacks: getOrchestratorCallbacks(userId),
      nsfwLevel: step.metadata?.isPrivateGeneration ? 'pg13' : undefined,
      allowMatureContent: step.metadata?.isPrivateGeneration ? false : allowMatureContent,
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
  });

  const [formatted] = await formatGenerationResponse([workflow]);
  return formatted;
}

export async function whatIf(args: GenerationSchema & Ctx) {
  const step = await createWorkflowStep(args);

  const workflow = await submitWorkflow({
    token: args.token,
    body: {
      steps: [step],
      experimental: args.experimental,
      allowMatureContent: args.allowMatureContent,
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies: args.currencies,
    },
    query: { whatif: true },
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
    allowMatureContent: workflow.allowMatureContent,
    transactions: workflow.transactions?.list,
    cost: workflow.cost,
    ready,
  };
}
