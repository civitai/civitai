import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { EntityType } from '~/shared/utils/prisma/enums';

/** `ModerationRule.definition` for a Model rule the `ModelRules` text scan evaluates. */
export const semanticModelRuleSchema = z.object({
  type: z.literal('semantic'),
  subject: z.string().trim().min(1),
  description: z.string().trim().default(''),
  aliases: z.array(z.string().trim().min(1)).default([]),
  needsAttention: z.boolean().optional(),
});

export type ModelRuleForPrompt = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
  /** Epoch ms; part of the rule-set fingerprint, so an edited rule changes the dedup hash. */
  updatedAt: number;
};

export async function getModelRulesForPrompt(): Promise<ModelRuleForPrompt[]> {
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
        // A regex definition, or a converted rule a person has not reviewed yet, never reaches the scan.
        const parsed = semanticModelRuleSchema.safeParse(row.definition);
        if (!parsed.success || parsed.data.needsAttention) return [];
        const { subject, description, aliases } = parsed.data;
        return [{ id: row.id, subject, description, aliases, updatedAt: row.updatedAt.getTime() }];
      });
    },
    { ttl: CacheTTL.day }
  );
}

export async function bustModelRulesCache() {
  await bustFetchThroughCache(REDIS_KEYS.CACHES.MOD_RULES.MODELS);
}

export function renderModelRulesBlock(rules: ModelRuleForPrompt[]) {
  const lines = rules.map((rule) => {
    const description = rule.description.replace(/\.+$/, '');
    const parts = [`[${rule.id}] ${rule.subject}${description ? ` — ${description}` : ''}`];
    if (rule.aliases.length) parts.push(`Also known as: ${rule.aliases.join(', ')}.`);
    return parts.join('. ');
  });
  return `### Rules\n${lines.join('\n')}`;
}

export function modelRulesFingerprint(rules: ModelRuleForPrompt[]) {
  return hashContent(rules.map((rule) => `${rule.id}:${rule.updatedAt}`).join(','));
}

export type ModelRuleSnapshot = {
  id: number;
  subject: string;
  description: string;
  aliases: string[];
};

/**
 * Read by id from the primary, not from the cache, and enabled only: a rule disabled after the
 * submit must stop acting at once, and a match on it is dropped.
 */
export async function getModelRuleSnapshots(ids: number[]): Promise<ModelRuleSnapshot[]> {
  if (!ids.length) return [];
  const rows = await dbWrite.moderationRule.findMany({
    where: { id: { in: ids }, entityType: EntityType.Model, enabled: true },
    select: { id: true, definition: true },
  });
  return rows.flatMap((row) => {
    const parsed = semanticModelRuleSchema.safeParse(row.definition);
    if (!parsed.success) return [];
    const { subject, description, aliases } = parsed.data;
    return [{ id: row.id, subject, description, aliases }];
  });
}

/**
 * Keeps one match per rule, and only rules the prompt actually listed: a model can name an id it
 * invented, and acting on one would unpublish a model for a rule nobody wrote.
 */
export function filterModelRuleMatches<T extends { ruleId: number }>(
  matched: T[],
  promptRuleIds: number[] | undefined
): { kept: T[]; dropped: number[] } {
  const allowed = new Set(promptRuleIds ?? []);
  const seen = new Set<number>();
  const kept: T[] = [];
  const dropped: number[] = [];
  for (const match of matched) {
    if (!allowed.has(match.ruleId)) dropped.push(match.ruleId);
    else if (!seen.has(match.ruleId)) {
      seen.add(match.ruleId);
      kept.push(match);
    }
  }
  return { kept, dropped };
}
