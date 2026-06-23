import { createJob } from '~/server/jobs/job';
import { processPromptRescreenQueue } from '~/server/services/orchestrator/promptAuditing';

// Deferred re-screen of generation prompts whose INLINE external moderation
// (OpenAI omni-moderation) call failed/timed-out and was skipped fail-soft.
// Drains the sysRedis queue and re-screens each prompt when OpenAI has recovered,
// applying the same consequence (mute escalation + audit record) as the inline path.
// See processPromptRescreenQueue in services/orchestrator/promptAuditing.ts.
// Bounded so the worst-case run (every re-screen hits the full external-moderation
// timeout) stays well under the 300s job lock — see RESCREEN_MAX_RUN_MS and the
// `batchSize × EXTERNAL_MODERATION_TIMEOUT_MS < lockExpiration(300s)` invariant.
// At ~5s/call, 100 items ≈ 500s worst case but the in-loop deadline (240s) caps it
// and re-enqueues the remainder; in practice most calls are fast on a recovered API.
const RESCREEN_BATCH_SIZE = 100;

export const rescreenSkippedPromptModeration = createJob(
  'rescreen-skipped-prompt-moderation',
  '*/5 * * * *',
  async () => await processPromptRescreenQueue(RESCREEN_BATCH_SIZE)
);
