import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { modelRuleFormSchema, ruleMatchesText } from '$lib/model-rules';
import { requiresGrant } from '$lib/server/access';
import { civitaiLinkUrl } from '$lib/server/civitai-url';
import {
  LegacyRuleError,
  MATCH_MODES,
  ModelRuleNotFoundError,
  convertLegacyModelRules,
  createModelRule,
  getModelRuleMatches,
  listModelRules,
  setModelRuleEnabled,
  updateModelRule,
} from '$lib/server/model-rules.service';
import { MAX_INT4 } from '$lib/server/users.service';
import { parseForm, parseQuery } from '$lib/server/query';

const PAGE_SIZE = 50;

const positiveInt = z.coerce.number().int().positive().max(MAX_INT4);

const querySchema = z.object({
  tab: z.enum(['rules', 'matches']).catch('rules'),
  q: z.string().trim().max(200).catch(''),
  status: z.enum(['all', 'enabled', 'disabled']).catch('all'),
  mode: z.enum(MATCH_MODES).catch('all'),
  rule: positiveInt.optional().catch(undefined),
  cursor: positiveInt.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const query = parseQuery(url, querySchema);
  const base = { query, civitaiUrl: civitaiLinkUrl() };

  if (query.tab === 'matches') {
    const matches = await getModelRuleMatches({
      mode: query.mode,
      ruleId: query.rule,
      cursor: query.cursor,
      limit: PAGE_SIZE,
    });
    return { ...base, rules: null, legacyCount: 0, total: 0, matches };
  }

  const all = await listModelRules();
  const rules = all.filter(
    (rule) =>
      (query.status === 'all' || rule.enabled === (query.status === 'enabled')) &&
      ruleMatchesText(rule, query.q)
  );
  return {
    ...base,
    rules,
    legacyCount: all.filter((r) => r.legacy).length,
    total: all.length,
    matches: null,
  };
};

const toggleSchema = z.object({ id: positiveInt, enabled: z.enum(['true', 'false']) });
const saveSchema = modelRuleFormSchema.extend({ id: positiveInt.optional().catch(undefined) });

const STALE = 'Could not clear the rules cache; the main app may serve the old rules for a while.';

export const actions: Actions = {
  save: requiresGrant('textScan.modelRules.edit', async ({ request, locals }) => {
    const form = await request.formData();
    const input = parseForm(saveSchema, form);
    if (typeof input === 'string') return fail(400, { error: input });
    if (form.get('id') && input.id === undefined) return fail(400, { error: 'Invalid rule.' });

    try {
      const { id, ...fields } = input;
      const result = id
        ? { id, ...(await updateModelRule(id, fields, locals.user.id)) }
        : await createModelRule(fields, locals.user.id);
      return {
        success: true,
        message: `Saved rule ${result.id}.`,
        cacheWarning: result.cacheStale ? STALE : null,
      };
    } catch (error) {
      if (error instanceof ModelRuleNotFoundError) return fail(404, { error: error.message });
      if (error instanceof LegacyRuleError) return fail(409, { error: error.message });
      throw error;
    }
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
        cacheWarning: result.cacheStale ? STALE : null,
      };
    } catch (error) {
      if (error instanceof ModelRuleNotFoundError) return fail(404, { error: error.message });
      throw error;
    }
  }),

  convert: requiresGrant('textScan.modelRules.edit', async ({ locals }) => {
    const result = await convertLegacyModelRules(locals.user.id);
    if (result.count === 0) return fail(409, { error: 'No regex rules left to convert.' });
    return {
      success: true,
      message: `Converted ${result.count} regex ${result.count === 1 ? 'rule' : 'rules'}.`,
      cacheWarning: result.cacheStale ? STALE : null,
    };
  }),
};
