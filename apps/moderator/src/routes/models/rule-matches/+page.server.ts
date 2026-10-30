import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { canViewTrainingData, denied } from '$lib/server/access';
import {
  BATCH_MAX,
  MODEL_RULE_HOLD_DECISIONS,
  MODEL_RULE_HOLD_MODES,
  MODEL_RULE_HOLD_SORTS,
  MODEL_RULE_HOLD_STATUSES,
  NOTE_MAX_LENGTH,
  STRIKE_GRANT,
  DEFAULT_MODEL_RULE_HOLD_FILTERS,
  type ModelRuleHoldFilters,
} from '$lib/model-rule-holds';
import { getHoldCoverImages, type CsamHoldCovers } from '$lib/server/csam-holds.queries';
import {
  countModelRuleHoldsByRule,
  countPendingModelRuleHolds,
  decideModelRuleHold,
  decideOwnerHolds,
  getHoldModelFacts,
  listModelRuleHolds,
  modelRuleHoldSearch,
  type HoldModelFacts,
} from '$lib/server/model-rule-holds.service';
import { int4Id, jsonField, parseForm, parseQuery } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';

const querySchema = z.object({
  limit: z.coerce.number().int().min(10).max(200).catch(50),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  status: z.enum(MODEL_RULE_HOLD_STATUSES).catch(DEFAULT_MODEL_RULE_HOLD_FILTERS.status),
  mode: z.enum(MODEL_RULE_HOLD_MODES).catch(DEFAULT_MODEL_RULE_HOLD_FILTERS.mode),
  sort: z.enum(MODEL_RULE_HOLD_SORTS).catch(DEFAULT_MODEL_RULE_HOLD_FILTERS.sort),
  rule: int4Id.optional().catch(undefined),
  q: z.string().trim().max(100).catch(''),
  owner: int4Id.optional().catch(undefined),
});

const NO_FACTS: HoldModelFacts = {
  baseModel: null,
  trainedWords: [],
  trainedWordCount: 0,
  tags: [],
  tagCount: 0,
};

export const load: PageServerLoad = async ({ url, locals }) => {
  const { limit, page, status, mode, sort, rule, q, owner } = parseQuery(url, querySchema);
  const offset = (page - 1) * limit;
  const filters: ModelRuleHoldFilters = { status, mode, sort, rule: rule ?? null };
  const queue = await listModelRuleHolds({
    ...filters,
    limit,
    offset,
    search: modelRuleHoldSearch(q),
    owner,
  });
  // Counts, images and facts are decoration: a failure leaves the list standing without them.
  const [pendingCount, rules, covers, facts] = await Promise.all([
    countPendingModelRuleHolds().catch((err) => {
      console.error('Model rule hold count failed', err);
      return null;
    }),
    // Every rule the current status, mode and owner narrow to, so the rule chips never hide the one in use.
    countModelRuleHoldsByRule({ status, mode, owner }).catch((err) => {
      console.error('Model rule counts failed', err);
      return [];
    }),
    getHoldCoverImages(
      queue.items.map((hold) => ({ id: hold.id, entityType: 'Model', entityId: hold.modelId }))
    ).catch((err) => {
      console.error('Model rule hold images failed', err);
      return new Map<number, CsamHoldCovers>();
    }),
    getHoldModelFacts(queue.items.map((hold) => hold.modelId)).catch((err) => {
      console.error('Model rule hold facts failed', err);
      return new Map<number, HoldModelFacts>();
    }),
  ]);
  const items = queue.items.map((hold) => ({
    ...hold,
    coverImages: covers.get(hold.id)?.images ?? [],
    facts: facts.get(hold.modelId) ?? NO_FACTS,
  }));
  return {
    limit,
    page,
    offset,
    q,
    owner: owner ?? null,
    holdFilters: filters,
    pendingCount,
    rules,
    items,
    hasMore: queue.hasMore,
    canViewTrainingData: canViewTrainingData(locals.user),
    fullBleed: true,
    headerInline: true,
  };
};

const alsoSchema = z
  .array(z.object({ holdId: int4Id, textHash: z.string().min(1).max(200) }))
  .max(BATCH_MAX);

const decideSchema = z.object({
  holdId: int4Id,
  textHash: z.string().min(1).max(200),
  decision: z.enum(MODEL_RULE_HOLD_DECISIONS),
  also: jsonField(alsoSchema).optional(),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX_LENGTH, `The note is longer than ${NOTE_MAX_LENGTH} characters.`)
    .optional()
    .transform((v) => v || undefined),
});

export const actions: Actions = {
  decide: async ({ request, locals }) => {
    const input = parseForm(decideSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    // Any moderator who reaches the page may rule; the strike keeps the grant it carries on every other page.
    if (input.decision === 'confirm_strike' && !locals.grants[STRIKE_GRANT])
      return fail(403, {
        scope: 'denied' as const,
        error: denied(STRIKE_GRANT),
        key: input.holdId,
      });

    const { also, ...primary } = input;
    const result = await decideModelRuleHold(primary);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    const others = also?.length
      ? await decideOwnerHolds({
          holdId: input.holdId,
          also,
          decision: input.decision,
          note: input.note,
        }).catch((err) => {
          console.error('Model rule hold batch decision failed', err);
          const targets = new Set(also.map((hold) => hold.holdId));
          targets.delete(input.holdId);
          return [...targets].map((holdId) => ({
            holdId,
            ok: false,
            error: 'Could not apply the decision to this hold.',
          }));
        })
      : undefined;
    return { success: true, key: input.holdId, ...(others ? { others } : {}) };
  },
};
