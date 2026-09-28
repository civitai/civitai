import {
  runTextScanHarnessAction,
  textScanHarnessSchema,
} from '~/server/services/text-scan/harness';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.harness', {
  summary: 'Text-scan operator actions: prompts, config, dry-run scans, shadow samples, quotes.',
  returns: "the action's JSON; a CSV sample as { csv }",
  notes: [
    'putPrompt/putConfig are attributed to the signed-in moderator; ids in the body are ignored.',
    'scanEntity/batchEntities submit real orchestrator workflows (billed; no EntityModeration write, no action). quoteEntities prices without running.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: textScanHarnessSchema,
  auditExclude: ['content', 'promptOverrides'],
  async handler(input, ctx) {
    const result = await runTextScanHarnessAction(input, { moderatorId: ctx.actor.id });
    return result.kind === 'csv' ? { csv: result.body } : (result.body as Record<string, unknown>);
  },
});
