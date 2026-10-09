import { sql } from 'kysely';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import {
  convertLegacyModelRule,
  isSemanticDefinition,
  parseRuleMatches,
  type ModelRuleForm,
  type RuleMatch,
  type SemanticModelRule,
} from '$lib/model-rules';
import { logToAxiom } from './axiom';
import { dbRead, dbWrite } from './db';
import { takePage } from './keyset-page';
import { recordModActivity } from './mod-activity';
import { getRedis } from './redis';
import { usersByIds } from './users.service';

// Owns the Model rows of ModerationRule and the shared Redis key the main app reads them through.
// Image rules share the table and are never read or written here: every statement names
// `entityType = 'Model'`.

const MODEL_RULES_KEY = REDIS_KEYS.CACHES.MOD_RULES.MODELS as RedisKeyTemplateCache;
const ACTIVITY_ENTITY = 'moderationRule';

/** Returns false rather than throwing: the row is already committed, and a throw would report failure
 *  for a write that succeeded (same rule as `blocklist.service.ts`). */
async function bustCache(): Promise<boolean> {
  try {
    await getRedis().del(MODEL_RULES_KEY);
    return true;
  } catch (error) {
    void logToAxiom({
      name: 'model-rules-cache-bust-failed',
      type: 'error',
      message: 'Model rule was written but its cache key was not cleared; readers stay stale',
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

export type ModelRuleView = {
  id: number;
  legacy: boolean;
  subject: string;
  description: string;
  aliases: string[];
  needsAttention: boolean;
  enabled: boolean;
  note: string;
  legacyMatch: string | null;
  editedById: number | null;
  editedBy: string | null;
  updatedAt: Date;
};

const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

export async function listModelRules(): Promise<ModelRuleView[]> {
  // `dbWrite`: the page reloads straight after a write, and the replica can still hold the old row.
  const rows = await dbWrite
    .selectFrom('ModerationRule')
    .select(['id', 'definition', 'enabled', 'reason', 'createdById', 'updatedAt'])
    .where('entityType', '=', 'Model')
    .orderBy(sql`"order" ASC NULLS LAST`)
    .orderBy('id', 'asc')
    .execute();

  const withEditor = rows.map((row) => {
    const semantic = convertLegacyModelRule(row.definition, row.reason);
    const legacy = !isSemanticDefinition(row.definition);
    return {
      row,
      semantic,
      legacy,
      editedById: (!legacy && semantic.updatedById) || row.createdById,
    };
  });
  const users = await usersByIds(withEditor.map((r) => r.editedById));

  return withEditor.map(({ row, semantic, legacy, editedById }) => ({
    id: row.id,
    legacy,
    subject: semantic.subject,
    description: semantic.description,
    aliases: semantic.aliases ?? [],
    needsAttention: !!semantic.needsAttention,
    enabled: row.enabled,
    note: row.reason ?? '',
    legacyMatch: semantic.legacyMatch === undefined ? null : prettyJson(semantic.legacyMatch),
    editedById,
    editedBy: users.get(editedById)?.username ?? null,
    updatedAt: row.updatedAt,
  }));
}

export type WriteResult = { cacheStale: boolean };

export class ModelRuleNotFoundError extends Error {
  constructor(message = 'That rule no longer exists. Reload the page.') {
    super(message);
    this.name = 'ModelRuleNotFoundError';
  }
}

export class LegacyRuleError extends Error {
  constructor() {
    super('This rule still uses regex. Convert the regex rules before editing it.');
    this.name = 'LegacyRuleError';
  }
}

export async function createModelRule(
  input: ModelRuleForm,
  userId: number
): Promise<WriteResult & { id: number }> {
  const definition: SemanticModelRule = {
    type: 'semantic',
    subject: input.subject,
    description: input.description,
    aliases: input.aliases,
    updatedById: userId,
  };
  const now = new Date();
  const created = await dbWrite
    .insertInto('ModerationRule')
    .values({
      entityType: 'Model',
      definition,
      action: 'Block',
      enabled: true,
      order: null,
      reason: input.note || null,
      createdById: userId,
      updatedAt: now,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: created.id,
    activity: 'create',
  });
  return { id: created.id, cacheStale };
}

/** Edits one rule, keeping `legacyMatch` and clearing `needsAttention` — saving is the act of reviewing. */
export async function updateModelRule(
  id: number,
  input: ModelRuleForm,
  userId: number
): Promise<WriteResult> {
  await dbWrite.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('ModerationRule')
      .select(['definition'])
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw new ModelRuleNotFoundError();
    if (!isSemanticDefinition(existing.definition)) throw new LegacyRuleError();

    const definition: SemanticModelRule = {
      type: 'semantic',
      subject: input.subject,
      description: input.description,
      aliases: input.aliases,
      ...(existing.definition.legacyMatch === undefined
        ? {}
        : { legacyMatch: existing.definition.legacyMatch }),
      updatedById: userId,
    };
    await trx
      .updateTable('ModerationRule')
      .set({ definition, reason: input.note || null, updatedAt: new Date() })
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
  });

  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: id,
    activity: 'edit',
  });
  return { cacheStale };
}

export async function setModelRuleEnabled(
  id: number,
  enabled: boolean,
  userId: number
): Promise<WriteResult> {
  await dbWrite.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('ModerationRule')
      .select(['definition'])
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw new ModelRuleNotFoundError();

    await trx
      .updateTable('ModerationRule')
      .set({
        enabled,
        updatedAt: new Date(),
        ...(isSemanticDefinition(existing.definition)
          ? { definition: { ...existing.definition, updatedById: userId } }
          : {}),
      })
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
  });

  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: id,
    activity: enabled ? 'enable' : 'disable',
  });
  return { cacheStale };
}

/** Converts every regex Model rule in place, keeping ids, `enabled`, `order` and `reason`. Idempotent:
 *  a second run finds nothing to convert. */
export async function convertLegacyModelRules(
  userId: number
): Promise<WriteResult & { count: number }> {
  const count = await dbWrite.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('ModerationRule')
      .select(['id', 'definition', 'reason'])
      .where('entityType', '=', 'Model')
      .forUpdate()
      .execute();

    let converted = 0;
    for (const row of rows) {
      if (isSemanticDefinition(row.definition)) continue;
      const definition: SemanticModelRule = {
        ...convertLegacyModelRule(row.definition, row.reason),
        updatedById: userId,
      };
      await trx
        .updateTable('ModerationRule')
        .set({ definition, action: 'Block', updatedAt: new Date() })
        .where('id', '=', row.id)
        .where('entityType', '=', 'Model')
        .executeTakeFirstOrThrow();
      converted++;
    }
    return converted;
  });

  if (count === 0) return { count: 0, cacheStale: false };
  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: null,
    activity: `convert-regex:${count}`,
  });
  return { count, cacheStale };
}

export const MATCH_MODES = ['all', 'shadow', 'active'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

const ENTITY_TYPES: Record<MatchMode, string[]> = {
  all: ['ModelRules', 'ModelRules:shadow'],
  shadow: ['ModelRules:shadow'],
  active: ['ModelRules'],
};

export type ModelRuleMatchRow = {
  id: number;
  modelId: number;
  modelName: string | null;
  mode: 'shadow' | 'active';
  scannedAt: Date;
  matches: RuleMatch[];
};

/**
 * Newest first by row id (a model's row is created on its first scan; a rescan updates it in place).
 * `entityType IN (...)` is what keeps this an index scan on (entityType, entityId) rather than a walk of
 * the whole table; the label and rule filters then apply to that small slice.
 */
export async function getModelRuleMatches({
  mode,
  ruleId,
  cursor,
  limit,
}: {
  mode: MatchMode;
  ruleId?: number;
  cursor?: number;
  limit: number;
}): Promise<{ items: ModelRuleMatchRow[]; nextCursor?: number }> {
  let query = dbRead
    .selectFrom('EntityModeration as em')
    .leftJoin('Model as m', 'm.id', 'em.entityId')
    .select([
      'em.id',
      'em.entityType',
      'em.entityId',
      'em.updatedAt',
      'em.result',
      'm.name as modelName',
    ])
    .where('em.entityType', 'in', ENTITY_TYPES[mode])
    .where(sql<boolean>`'modelRules' = ANY(em."triggeredLabels")`);
  if (ruleId !== undefined)
    query = query.where(
      sql<boolean>`em.result #> '{labels,modelRules,matched}' @> ${JSON.stringify([
        { ruleId },
      ])}::jsonb`
    );
  if (cursor !== undefined) query = query.where('em.id', '<', cursor);

  const rows = await query
    .orderBy('em.id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = takePage(rows, limit, (r) => r.id);
  return {
    items: page.items.map((r) => ({
      id: r.id,
      modelId: r.entityId,
      modelName: r.modelName,
      mode: r.entityType === 'ModelRules:shadow' ? 'shadow' : 'active',
      scannedAt: r.updatedAt,
      matches: parseRuleMatches(r.result),
    })),
    nextCursor: page.nextCursor,
  };
}
