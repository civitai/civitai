import {
  storedModelRuleSchema,
  type ModelRuleCategory,
  type ModelRuleReference,
} from '@civitai/moderation/model-rules';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { EntityType } from '~/shared/utils/prisma/enums';

export type EnabledModelRule = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
  /** Absent on an entry cached before these fields existed. */
  category?: ModelRuleCategory;
  references?: ModelRuleReference[];
  updatedAt: number;
};

export async function getEnabledModelRules(): Promise<EnabledModelRule[]> {
  return fetchThroughCache(
    REDIS_KEYS.CACHES.MOD_RULES.MODELS,
    async () => {
      // Primary: the moderator app busts this key right after its write, and a replica read here
      // would cache the pre-write rules for the whole TTL.
      const rows = await dbWrite.moderationRule.findMany({
        where: { entityType: EntityType.Model, enabled: true },
        select: { id: true, definition: true, updatedAt: true, order: true },
        orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      });
      return rows.flatMap((row) => {
        // A regex definition, or a converted rule a person has not reviewed yet, never reaches the matcher.
        const parsed = storedModelRuleSchema.safeParse(row.definition);
        if (!parsed.success || parsed.data.needsAttention) return [];
        const { subject, description, aliases, category, references } = parsed.data;
        return [
          {
            id: row.id,
            subject,
            description,
            aliases,
            category,
            references,
            updatedAt: row.updatedAt.getTime(),
          },
        ];
      });
    },
    { ttl: CacheTTL.day }
  );
}

/** A moderator's unsaved edit of a rule, tried before it is saved: a positive id replaces that rule, a negative id is a new, unsaved one. */
export type ModelRuleOverride = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
  enabled: boolean;
};

export function applyModelRuleOverrides(
  live: EnabledModelRule[],
  overrides: ModelRuleOverride[] | undefined
): EnabledModelRule[] {
  if (!overrides?.length) return live;
  const toRule = ({ id, subject, description, aliases }: ModelRuleOverride): EnabledModelRule => ({
    id,
    subject,
    description,
    aliases,
    updatedAt: 0,
  });
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const merged = live.flatMap((rule) => {
    const edit = byId.get(rule.id);
    if (!edit) return [rule];
    return edit.enabled ? [toRule(edit)] : [];
  });
  const liveIds = new Set(live.map((rule) => rule.id));
  for (const edit of overrides)
    if (!liveIds.has(edit.id) && edit.enabled) merged.push(toRule(edit));
  return merged;
}

// Rendered to the owner by the unpublish notification for reason `other`; it must never name the rule.
export const MODEL_RULES_UNPUBLISH_MESSAGE =
  'This model was unpublished because it matched one of our content rules. A moderator will review it.';

/** Subjects by id, enabled or not, so a moderator can read which rule acted even after it was disabled. */
export async function getModelRuleSubjects(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await dbRead.moderationRule.findMany({
    where: { id: { in: ids }, entityType: EntityType.Model },
    select: { id: true, definition: true },
  });
  return new Map(
    rows.flatMap((row) => {
      const parsed = storedModelRuleSchema.safeParse(row.definition);
      return parsed.success ? [[row.id, parsed.data.subject] as const] : [];
    })
  );
}

export type ModelRulesUnpublishDetail = {
  source: 'literal' | 'model';
  rules: { id: number; subject: string | null }[];
};

/** For the moderator panel: the rules behind the current unpublish, when the Model rules unpublished it. */
export function modelRulesUnpublishDetail(
  meta: Pick<ModelMeta, 'modelRules' | 'unpublishedReason' | 'customMessage'>,
  subjects: ReadonlyMap<number, string>
): ModelRulesUnpublishDetail | null {
  const taken = meta.modelRules;
  if (
    !taken?.ruleIds?.length ||
    meta.unpublishedReason !== 'other' ||
    meta.customMessage !== MODEL_RULES_UNPUBLISH_MESSAGE
  )
    return null;
  return {
    source: taken.source === 'literal' ? 'literal' : 'model',
    rules: taken.ruleIds.map((id) => ({ id, subject: subjects.get(id) ?? null })),
  };
}

/** Best effort: a failed subject lookup names the rules by id rather than failing the moderator panel. */
export async function loadModelRulesUnpublishDetail(
  meta: Pick<ModelMeta, 'modelRules' | 'unpublishedReason' | 'customMessage'>
): Promise<ModelRulesUnpublishDetail | null> {
  const detail = modelRulesUnpublishDetail(meta, new Map());
  if (!detail) return null;
  try {
    return modelRulesUnpublishDetail(
      meta,
      await getModelRuleSubjects(detail.rules.map((r) => r.id))
    );
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'text-scan',
      message: 'Failed to load Model rule subjects for the moderation panel',
      error,
    });
    return detail;
  }
}
