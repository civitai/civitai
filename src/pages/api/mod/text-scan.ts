import {
  runTextScanHarnessAction,
  textScanHarnessSchema,
} from '~/server/services/text-scan/harness';
import { TRPCError } from '@trpc/server';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

// Each returns an entity's text or text derived from it (a verdict's reason, the model's raw reply),
// private messages included, so a delegated token reaches them only at full scope.
const ENTITY_TEXT_ACTIONS = new Set([
  'composeEntities',
  'sampleShadow',
  'scanEntity',
  'batchEntities',
]);

// The harness's own caps bound a request at ~1M characters, which multibyte text can take past the
// 1mb default.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default defineModeratorEndpoint('textScan.harness', {
  summary: 'Text-scan operator actions: prompts, config, dry-run scans, shadow samples, quotes.',
  returns: "the action's JSON; a CSV sample as { csv }",
  notes: [
    'putPrompt/putConfig are attributed to the signed-in moderator; ids in the body are ignored.',
    'scanEntity/batchEntities/scanTexts submit real orchestrator workflows (billed; no EntityModeration write, no action). quoteEntities/quoteTexts price without running; composeEntities returns the composed text only.',
    'composeEntities, sampleShadow, scanEntity and batchEntities refuse a delegated token that is not full-scope. A cookie session carries no scope and is unaffected.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: textScanHarnessSchema,
  auditExclude: ['content', 'promptOverrides', 'texts'],
  async handler(input, ctx) {
    if (ENTITY_TEXT_ACTIONS.has(input.action) && !Flags.hasFlag(ctx.tokenScope, TokenScope.Full))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Your API key does not have the required scope for this action',
      });
    const result = await runTextScanHarnessAction(input, { moderatorId: ctx.actor.id });
    return result.kind === 'csv' ? { csv: result.body } : (result.body as Record<string, unknown>);
  },
});
