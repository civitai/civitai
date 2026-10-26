import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { modelRuleFormSchema, type ModelRuleForm } from '$lib/model-rules';
import { requiresGrant } from '$lib/server/access';
import { logAxiomError } from '$lib/server/axiom';
import {
  LegacyRuleError,
  ModelRuleNotFoundError,
  ModelRuleStaleError,
  ModelRuleVersionNotFoundError,
  RestoreRefusedError,
  RuleNeedsReviewError,
  countNotSubjectDismissalsByRule,
  createModelRule,
  listModelRules,
  restoreModelRuleVersion,
  setModelRuleEnabled,
  updateModelRule,
} from '$lib/server/model-rules.service';
import { int4Id, jsonField, parseForm, parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { runLiteralTry } from './literal-try.server';
import { runAliasSuggestionResult, runSuggestAliases } from './suggest-aliases.server';

const querySchema = z.object({
  q: z.string().trim().max(200).catch(''),
  status: z.enum(['all', 'enabled', 'disabled']).catch('all'),
});

export const load: PageServerLoad = async ({ url }) => {
  const query = parseQuery(url, querySchema);
  // The counts are decoration: a failure leaves the rules listed without them.
  const [rules, dismissals] = await Promise.all([
    listModelRules(),
    countNotSubjectDismissalsByRule().catch((err) => {
      console.error('Model rule dismissal counts failed', err);
      return {} as Record<number, number>;
    }),
  ]);
  return { query, rules, dismissals, wide: true };
};

const ruleSaveSchema = modelRuleFormSchema.extend({
  id: int4Id.optional().catch(undefined),
  baseUpdatedAt: z.string().max(40).optional(),
});
const toggleSchema = z.object({ id: int4Id, enabled: z.enum(['true', 'false']) });
const restoreRuleSchema = z.object({ ruleId: int4Id, versionId: int4Id });
const saveAllSchema = z.object({
  rules: jsonField(
    z
      .array(
        z.object({
          draftId: z.number().int(),
          id: z.number().int().positive().max(MAX_INT4).optional(),
          subject: z.string(),
          description: z.string(),
          aliases: z.string(),
          category: z.string().default(''),
          references: z.array(z.object({ url: z.string(), label: z.string().optional() })).default([]),
          note: z.string(),
          baseUpdatedAt: z.string().max(40).optional(),
        })
      )
      .min(1, 'There are no edited rules to save.')
      .max(500),
    'Malformed rules.'
  ),
});

const STALE_CACHE =
  'Could not clear the rules cache; the main app may serve the old rules for a while.';

/** A rule write's refusal in the moderator's words; anything else is a bug and propagates. */
function ruleRefusal(error: unknown): { status: number; error: string } {
  if (error instanceof ModelRuleNotFoundError || error instanceof ModelRuleVersionNotFoundError)
    return { status: 404, error: error.message };
  if (
    error instanceof LegacyRuleError ||
    error instanceof ModelRuleStaleError ||
    error instanceof RuleNeedsReviewError
  )
    return { status: 409, error: error.message };
  if (error instanceof RestoreRefusedError) return { status: 400, error: error.message };
  throw error;
}

async function saveRule(
  input: ModelRuleForm & { id?: number; baseUpdatedAt?: string },
  userId: number
): Promise<{ id: number; cacheStale: boolean }> {
  const { id, baseUpdatedAt, ...fields } = input;
  return id
    ? { id, ...(await updateModelRule(id, fields, userId, { baseUpdatedAt })) }
    : createModelRule(fields, userId);
}

export const actions: Actions = {
  try: async ({ request }) => runLiteralTry(await request.formData()),

  // Billed on every run, so it takes the same grant as saving the rule it feeds.
  suggestAliases: requiresGrant('textScan.modelRules.edit', async ({ request }) =>
    runSuggestAliases(await request.formData())
  ),

  // Free to repeat, but it reads the billed search, so it takes the same grant.
  aliasSuggestionResult: requiresGrant('textScan.modelRules.edit', async ({ request }) =>
    runAliasSuggestionResult(await request.formData())
  ),

  save: requiresGrant('textScan.modelRules.edit', async ({ request, locals }) => {
    const form = await request.formData();
    const input = parseForm(ruleSaveSchema, form);
    if (typeof input === 'string') return fail(400, { error: input });
    if (form.get('id') && input.id === undefined) return fail(400, { error: 'Invalid rule.' });
    try {
      const result = await saveRule(input, locals.user.id);
      return {
        success: true,
        id: result.id,
        message: `Saved rule ${result.id}.`,
        cacheWarning: result.cacheStale ? STALE_CACHE : null,
      };
    } catch (error) {
      const refusal = ruleRefusal(error);
      return fail(refusal.status, { error: refusal.error });
    }
  }),

  saveAll: requiresGrant('textScan.modelRules.edit', async ({ request, locals }) => {
    const input = parseForm(saveAllSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const saved: { draftId: number; id: number }[] = [];
    const failed: { draftId: number; error: string }[] = [];
    let cacheStale = false;
    for (const { draftId, id, baseUpdatedAt, ...raw } of input.rules) {
      const fields = modelRuleFormSchema.safeParse(raw);
      if (!fields.success) {
        failed.push({ draftId, error: fields.error.issues[0]?.message ?? 'Invalid rule.' });
        continue;
      }
      try {
        const result = await saveRule({ ...fields.data, id, baseUpdatedAt }, locals.user.id);
        saved.push({ draftId, id: result.id });
        cacheStale ||= result.cacheStale;
      } catch (error) {
        let message = 'An unexpected error stopped this rule; reload to check whether it saved.';
        try {
          message = ruleRefusal(error).error;
        } catch {
          void logAxiomError(error, { event: 'model rules save all failed', ruleId: id ?? null });
        }
        failed.push({ draftId, error: message });
      }
    }
    const cacheWarning = cacheStale ? STALE_CACHE : null;
    if (failed.length)
      return fail(422, {
        error: `Saved ${saved.length}; ${failed.length} not saved: ${failed
          .map((f) => f.error)
          .join(' ')}`,
        saved,
        failed,
        cacheWarning,
      });
    return { success: true, message: `Saved ${saved.length} rules.`, saved, cacheWarning };
  }),

  toggle: requiresGrant('textScan.modelRules.edit', async ({ request, locals }) => {
    const input = parseForm(toggleSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const enabled = input.enabled === 'true';
    try {
      const result = await setModelRuleEnabled(input.id, enabled, locals.user.id);
      return {
        success: true,
        message: `Rule ${input.id} ${enabled ? 'enabled' : 'disabled'}.`,
        cacheWarning: result.cacheStale ? STALE_CACHE : null,
      };
    } catch (error) {
      const refusal = ruleRefusal(error);
      return fail(refusal.status, { error: refusal.error });
    }
  }),

  restoreRule: requiresGrant('textScan.modelRules.edit', async ({ request, locals }) => {
    const input = parseForm(restoreRuleSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const result = await restoreModelRuleVersion(input.ruleId, input.versionId, locals.user.id);
      return {
        success: true,
        message: result.flagged
          ? `Restored rule ${input.ruleId} as needing review (disabled).`
          : `Restored rule ${input.ruleId}.`,
        cacheWarning: result.cacheStale ? STALE_CACHE : null,
      };
    } catch (error) {
      const refusal = ruleRefusal(error);
      return fail(refusal.status, { error: refusal.error });
    }
  }),
};
