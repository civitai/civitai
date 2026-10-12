import {
  runTextScanHarnessAction,
  textScanHarnessSchema,
} from '~/server/services/text-scan/harness';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

// The harness's own caps bound a request at ~1M characters, which multibyte text can take past the
// 1mb default.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default defineModeratorEndpoint('textScan.harness', {
  summary:
    'Text-scan operator actions: prompts, config, rollout modes, dry-run scans, shadow samples, quotes.',
  returns: "the action's JSON; a CSV sample as { csv }",
  notes: [
    'putPrompt/putConfig/putModes are attributed to the signed-in moderator; ids in the body are ignored.',
    'putModes sets the rollout of one entity type { shadow, active } (percent of entity ids; null = off); any active share needs allowActive: true.',
    'scanEntity/batchEntities/scanTexts submit real orchestrator workflows (billed; no EntityModeration write, no action). quoteEntities/quoteTexts price without running; composeEntities returns the composed text only.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: textScanHarnessSchema,
  auditExclude: ['content', 'promptOverrides', 'texts'],
  async handler(input, ctx) {
    const result = await runTextScanHarnessAction(input, { moderatorId: ctx.actor.id });
    return result.kind === 'csv' ? { csv: result.body } : (result.body as Record<string, unknown>);
  },
});
