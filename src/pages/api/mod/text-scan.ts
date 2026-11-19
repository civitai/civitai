import {
  runTextScanHarnessAction,
  textScanHarnessSchema,
} from '~/server/services/text-scan/harness';
import {
  isRestorableTextScanPrompt,
  stampPromptRevocations,
} from '~/server/services/text-scan/prompt';
import { getSystemPermissions } from '~/server/services/system-cache';
import { TRPCError } from '@trpc/server';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

/** A granted permission (see `retool*` in feature-flags.service.ts) for the actions that change what
 *  production scans: its prompts, its model config and its rollouts. */
const TEXT_SCAN_PROMPT_PUBLISH_PERMISSION = 'textScanPromptPublish';
const PUBLISH_ACTIONS: ReadonlySet<string> = new Set([
  'putPrompt',
  'putConfig',
  'putModes',
  'putWebSearchModes',
  'putLabelModes',
]);
const INTENT_PROMPT_KEY = 'label:model-com-face-intent';
const INTENT_PROMPT_PUBLISH_PERMISSION = 'textScanPromptPublishIntent';

// The harness's own caps bound a request at ~1M characters, which multibyte text can take past the
// 1mb default.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default defineModeratorEndpoint('textScan.harness', {
  summary:
    'Text-scan operator actions: prompts, config, rollout modes, dry-run scans, shadow samples, quotes.',
  returns: "the action's JSON; a CSV sample as { csv }",
  notes: [
    'putPrompt/putConfig/putModes/putWebSearchModes/putLabelModes are attributed to the signed-in moderator; ids in the body are ignored.',
    'putPrompt, putConfig, putModes, putWebSearchModes and putLabelModes require the textScanPromptPublish permission.',
    'putPrompt for label:model-com-face-intent also requires textScanPromptPublishIntent, unless the content is exactly an earlier version by a current holder that no later stamped note revokes (a restore). A holder retires a version with revokes:<id> in a later note, saved stamped as holder-revokes:<id>; the stamp outlives the grant of whoever wrote it. A note by a non-holder is saved unstamped (any stamp it types is undone) and retires nothing; a holder lifts a revocation by saving that version again.',
    'putModes sets the rollout of one entity type { shadow, active } (percent of entity ids; null = off); any active share needs allowActive: true.',
    'putWebSearchModes sets the web-search pass rollout the same way (Model only; capped by the putModes mode). getPrompts returns both as modes and webSearchModes.',
    'scanEntity/batchEntities/scanTexts submit real orchestrator workflows (billed; no EntityModeration write, no action). quoteEntities/quoteTexts price without running; composeEntities returns the composed text only; composeComFaceIntent { modelIds } returns the fields the live intent check reads for each model (name, description, owner trigger words).',
    "scanEntity/batchEntities/scanTexts/quoteEntities/quoteTexts take pass: 'main' (default; every profile label, no tools) or 'web-search' (only poi/minor, with the civitai:web_search tool, as production's Model web-search pass runs them; other entity types are refused). Run both passes for a full picture: results carry pass, labels and, for scans, costTotal.",
    'literalModelRules matches texts against the saved Model rules (no LLM, no workflow, nothing billed); its ruleOverrides (lab only) apply to that action alone: a positive id replaces that Model rule, a negative id adds an unsaved one, enabled:false drops it. Every other action ignores ruleOverrides.',
    'suggestModelRuleAliases { subject, description?, existingAliases? } submits ONE billed orchestrator chat completion with web search (never retried) and waits at most a few seconds: { ok: true, status: "pending", workflowId } while it runs, { ok: true, status: "done", suggestions: [{ alias, kind, note?, source? }], costTotal } when it finished, or { ok: false, error }.',
    'aliasSuggestionResult { workflowId, subject, existingAliases? } reads that search back (only workflows suggestModelRuleAliases created): { ok: true, status: "pending" }, { ok: true, status: "done", suggestions, costTotal } with the subject, existing aliases and terms the matcher would ignore already removed, { ok: true, status: "failed", error }, or { ok: false, error } when the workflow cannot be read.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: textScanHarnessSchema,
  auditExclude: ['content', 'promptOverrides', 'ruleOverrides', 'texts'],
  async handler(input, ctx) {
    if (
      PUBLISH_ACTIONS.has(input.action) &&
      !ctx.actor.permissions?.includes(TEXT_SCAN_PROMPT_PUBLISH_PERMISSION)
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Permission "${TEXT_SCAN_PROMPT_PUBLISH_PERMISSION}" required for ${input.action}`,
      });
    const intentPut = input.action === 'putPrompt' && input.key === INTENT_PROMPT_KEY;
    const intentHolder = !!ctx.actor.permissions?.includes(INTENT_PROMPT_PUBLISH_PERMISSION);
    // A restore is the fast rollback, so it may only bring back unrevoked text, whoever asks.
    if (input.action === 'putPrompt' && intentPut && (!intentHolder || input.restore)) {
      const holders = (await getSystemPermissions())[INTENT_PROMPT_PUBLISH_PERMISSION] ?? [];
      const restorable = await isRestorableTextScanPrompt({
        key: input.key,
        content: input.content,
        authorIds: holders,
      });
      if (!restorable)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: input.restore
            ? `That ${INTENT_PROMPT_KEY} version was revoked or not written by a holder: save it as new text instead`
            : `Permission "${INTENT_PROMPT_PUBLISH_PERMISSION}" required to publish new ${INTENT_PROMPT_KEY} text`,
        });
    }
    if (input.action === 'putPrompt' && intentPut)
      input = { ...input, note: stampPromptRevocations(input.note, intentHolder) };
    const result = await runTextScanHarnessAction(input, { moderatorId: ctx.actor.id });
    return result.kind === 'csv' ? { csv: result.body } : (result.body as Record<string, unknown>);
  },
});
