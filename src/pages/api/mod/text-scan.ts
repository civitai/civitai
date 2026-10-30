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
    'putPrompt/putConfig/putModes/putWebSearchModes are attributed to the signed-in moderator; ids in the body are ignored.',
    'putModes sets the rollout of one entity type { shadow, active } (percent of entity ids; null = off); any active share needs allowActive: true.',
    'putWebSearchModes sets the web-search pass rollout the same way (Model only; capped by the putModes mode). getPrompts returns both as modes and webSearchModes.',
    'scanEntity/batchEntities/scanTexts submit real orchestrator workflows (billed; no EntityModeration write, no action). quoteEntities/quoteTexts price without running; composeEntities returns the composed text only.',
    "scanEntity/batchEntities/scanTexts/quoteEntities/quoteTexts take pass: 'main' (default; every profile label, no tools) or 'web-search' (only poi/minor, with the civitai:web_search tool, as production's Model web-search pass runs them; other entity types are refused). Run both passes for a full picture: results carry pass, labels and, for scans, costTotal.",
    'literalModelRules matches texts against the saved Model rules (no LLM, no workflow, nothing billed); its ruleOverrides (lab only) apply to that action alone: a positive id replaces that Model rule, a negative id adds an unsaved one, enabled:false drops it. Every other action ignores ruleOverrides.',
    'suggestModelRuleAliases { subject, description?, existingAliases? } submits ONE billed orchestrator chat completion with web search (never retried) and waits at most a few seconds: { ok: true, status: "pending", workflowId } while it runs, { ok: true, status: "done", suggestions: [{ alias, kind, note?, source? }], costTotal } when it finished, or { ok: false, error }.',
    'aliasSuggestionResult { workflowId, subject, existingAliases? } reads that search back (only workflows suggestModelRuleAliases created): { ok: true, status: "pending" }, { ok: true, status: "done", suggestions, costTotal } with the subject, existing aliases and terms the matcher would ignore already removed, { ok: true, status: "failed", error }, or { ok: false, error } when the workflow cannot be read.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: textScanHarnessSchema,
  auditExclude: ['content', 'promptOverrides', 'ruleOverrides', 'texts'],
  async handler(input, ctx) {
    const result = await runTextScanHarnessAction(input, { moderatorId: ctx.actor.id });
    return result.kind === 'csv' ? { csv: result.body } : (result.body as Record<string, unknown>);
  },
});
