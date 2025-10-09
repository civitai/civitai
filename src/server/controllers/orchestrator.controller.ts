import { NsfwLevel } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { getGenerationTags } from '~/server/orchestrator/generation/generation.schema';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import { createWorkflowStep } from '~/server/services/orchestrator/orchestrator.service';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { createLimiter } from '~/server/utils/rate-limiting';
import { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { auditPrompt } from '~/utils/metadata/audit';
import { getRandomInt } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '../redis/client';
import { clickhouse } from '../clickhouse/client';


type Ctx = { token: string; userId: number; experimental?: boolean; allowMatureContent: boolean , currencies?: BuzzSpendType[]};

const blockedPromptLimiter = createLimiter({
  counterKey: REDIS_KEYS.GENERATION.COUNT,
  limitKey: REDIS_SYS_KEYS.GENERATION.LIMITS,
  fetchCount: async (userKey) => {
    if (!clickhouse) return 0;
    const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM prohibitedRequests
      WHERE time > subtractHours(now(), 24) AND userId = ${userKey}
    `;
    const count = data[0]?.count ?? 0;
    return count;
  },
});

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
  ...args
}: GenerationSchema &
  Ctx & { isGreen?: boolean; isModerator?: boolean; track?: any }) {
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
      // nsfwLevel: isGreen ? NsfwLevel.P_G13 : undefined,
      allowMatureContent,
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
    cost: workflow.cost,
    ready,
  };
}
