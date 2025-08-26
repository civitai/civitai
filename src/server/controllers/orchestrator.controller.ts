import { NsfwLevel } from '@civitai/client';
import { clickhouse } from '~/server/clickhouse/client';
import { constants, maxRandomSeed } from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import type { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { getGenerationTags } from '~/server/orchestrator/generation/generation.schema';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import { createWorkflowStep } from '~/server/services/orchestrator/orchestrator.service';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { createLimiter } from '~/server/utils/rate-limiting';
import { auditPrompt } from '~/utils/metadata/audit';
import { getRandomInt } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

type Ctx = { token: string; userId: number; experimental?: boolean; allowMatureContent: boolean };

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
  ...args
}: GenerationSchema & Ctx & { isGreen?: boolean }) {
  // throw throwBadRequestError(`Your prompt was flagged for: `);
  if ('prompt' in args.data) {
    try {
      const negativePrompt =
        'negativePrompt' in args.data ? (args.data.negativePrompt as string) : undefined;
      const { blockedFor, success } = auditPrompt(args.data.prompt, negativePrompt);
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

      const count = (await blockedPromptLimiter.getCount(userId.toString())) ?? 0;
      await blockedPromptLimiter.increment(userId.toString());

      let message = `Your prompt was flagged: ${error.blockedFor.join(', ')}`;
      if (count > constants.imageGeneration.requestBlocking.warned)
        message +=
          '. If you continue to attempt blocked prompts, your account will be sent for review.';
      else if (count > constants.imageGeneration.requestBlocking.notified)
        message +=
          '. Your account has been sent for review. If you continue to attempt blocked prompts, your generation permissions will be revoked.';
      else if (count > constants.imageGeneration.requestBlocking.muted)
        message += '. Your account has been muted.';

      throw throwBadRequestError(message);
    }
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
      nsfwLevel: isGreen ? NsfwLevel.P_G13 : undefined,
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
