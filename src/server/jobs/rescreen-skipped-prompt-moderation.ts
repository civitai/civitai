import { createJob } from '~/server/jobs/job';
import { processPromptRescreenQueue } from '~/server/services/orchestrator/promptAuditing';

// Deferred re-screen of generation prompts whose INLINE external moderation
// (OpenAI omni-moderation) call failed/timed-out and was skipped fail-soft.
// Drains the sysRedis queue and re-screens each prompt when OpenAI has recovered,
// applying the same consequence (mute escalation + audit record) as the inline path.
// See processPromptRescreenQueue in services/orchestrator/promptAuditing.ts.
const RESCREEN_BATCH_SIZE = 500;

export const rescreenSkippedPromptModeration = createJob(
  'rescreen-skipped-prompt-moderation',
  '*/5 * * * *',
  async () => await processPromptRescreenQueue(RESCREEN_BATCH_SIZE)
);
