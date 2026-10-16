import { convertLegacyModelRule } from '@civitai/moderation/model-rules-convert';
import { isSemanticDefinition, storedModelRuleSchema } from '@civitai/moderation/model-rules';
import type { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { EntityType } from '~/shared/utils/prisma/enums';

type LegacyRow = {
  id: number;
  definition: unknown;
  reason: string | null;
  action: string;
  enabled: boolean;
};

// A rule the conversion cannot carry faithfully (flagged, or an `Approve` rule, which meant "leave
// these alone") arrives disabled, so it acts on nothing until a person rewrites it.
function plan(row: LegacyRow) {
  const conversion = convertLegacyModelRule(row.definition, row.reason);
  const flagged = !!conversion.needsAttention || row.action === 'Approve';
  const definition = storedModelRuleSchema.parse({
    ...conversion,
    ...(flagged ? { needsAttention: true } : {}),
  });
  return { definition, flagged };
}

async function loadLegacyRows() {
  const rows = await dbWrite.moderationRule.findMany({
    where: { entityType: EntityType.Model },
    select: { id: true, definition: true, reason: true, action: true, enabled: true },
    orderBy: { id: 'asc' },
  });
  return rows.filter((row) => !isSemanticDefinition(row.definition));
}

export async function countLegacyModelRules() {
  const plans = (await loadLegacyRows()).map(plan);
  const flagged = plans.filter((p) => p.flagged).length;
  return { legacy: plans.length, clean: plans.length - flagged, flagged };
}

/**
 * Idempotent: converted rows are semantic, so a re-run finds nothing and a partial run resumes. Each
 * rule's update and its history row land together, so the moderator app's "(current)" version never
 * lags the rule; `actorId` is recorded as the author, the system user when no one is named.
 */
export async function convertLegacyModelRules(actorId: number = constants.system.user.id) {
  const rows = await loadLegacyRows();
  let flaggedCount = 0;
  for (const row of rows) {
    const { definition, flagged } = plan(row);
    await dbWrite.$transaction(async (tx) => {
      await tx.moderationRule.update({
        where: { id: row.id, entityType: EntityType.Model },
        data: {
          definition: definition as Prisma.InputJsonObject,
          action: 'Block',
          ...(flagged ? { enabled: false } : {}),
        },
      });
      await tx.moderationRuleVersion.create({
        data: {
          ruleId: row.id,
          definition: definition as Prisma.InputJsonObject,
          enabled: flagged ? false : row.enabled,
          action: 'Block',
          reason: row.reason,
          createdById: actorId,
        },
      });
    });
    if (flagged) flaggedCount++;
  }
  if (rows.length) await bustFetchThroughCache(REDIS_KEYS.CACHES.MOD_RULES.MODELS);
  return { converted: rows.length, flagged: flaggedCount };
}
