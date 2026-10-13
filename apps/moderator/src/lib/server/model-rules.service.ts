import { sql, type Insertable, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { convertLegacyModelRule } from '@civitai/moderation/model-rules-convert';
import {
  isSemanticDefinition,
  parseMatchCursor,
  parseRuleMatches,
  semanticModelRuleSchema,
  type ModelRuleForm,
  type RuleMatch,
} from '$lib/model-rules';
import { sameRuleState, type ModelRuleVersionView } from '$lib/model-rule-versions';
import { bustKeyBestEffort } from './cache';
import { dbRead, dbWrite } from './db';
import { takePage } from './keyset-page';
import { recordModActivity } from './mod-activity';
import { usersByIds } from './users.service';

// Image rules share the ModerationRule table: every statement here must name `entityType = 'Model'`.

const MODEL_RULES_KEY = REDIS_KEYS.CACHES.MOD_RULES.MODELS as RedisKeyTemplateCache;
const ACTIVITY_ENTITY = 'moderationRule';

const bustCache = () =>
  bustKeyBestEffort(MODEL_RULES_KEY, {
    logName: 'model-rules-cache-bust-failed',
    message: 'Model rule was written but its cache key was not cleared; readers stay stale',
  });

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
    super('This rule still uses regex and cannot be edited until it is converted.');
    this.name = 'LegacyRuleError';
  }
}

export class ModelRuleStaleError extends Error {
  constructor() {
    super('Someone saved this rule after your edit started. Reload, compare, then edit again.');
    this.name = 'ModelRuleStaleError';
  }
}

export class ModelRuleVersionNotFoundError extends Error {
  constructor() {
    super('That version is not in this rule’s history. Reload the page.');
    this.name = 'ModelRuleVersionNotFoundError';
  }
}

export class RestoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRefusedError';
  }
}

type Trx = Transaction<DB>;

function lockRule(trx: Trx, id: number) {
  return trx
    .selectFrom('ModerationRule')
    .select(['id', 'definition', 'enabled', 'action', 'reason', 'createdById', 'updatedAt'])
    .where('id', '=', id)
    .where('entityType', '=', 'Model')
    .forUpdate()
    .executeTakeFirst();
}
type LockedRule = NonNullable<Awaited<ReturnType<typeof lockRule>>>;
type RuleState = Pick<LockedRule, 'definition' | 'enabled' | 'action' | 'reason'>;

const editorOf = (rule: LockedRule) =>
  (isSemanticDefinition(rule.definition) && rule.definition.updatedById) || rule.createdById;

/**
 * Appends `next` to the rule's history. A rule written before history was kept has none, so its
 * state before this write goes in first, attributed and dated as it was last written.
 */
async function appendVersion(
  trx: Trx,
  ruleId: number,
  before: LockedRule | null,
  next: RuleState,
  userId: number
) {
  const rows: Insertable<DB['ModerationRuleVersion']>[] = [];
  if (before) {
    const any = await trx
      .selectFrom('ModerationRuleVersion')
      .select('id')
      .where('ruleId', '=', ruleId)
      .limit(1)
      .executeTakeFirst();
    if (!any)
      rows.push({
        ruleId,
        definition: before.definition,
        enabled: before.enabled,
        action: before.action,
        reason: before.reason,
        createdById: editorOf(before),
        createdAt: before.updatedAt,
      });
  }
  rows.push({ ruleId, ...next, createdById: userId });
  await trx.insertInto('ModerationRuleVersion').values(rows).execute();
}

const viewOf = (definition: unknown, reason: string | null, enabled: boolean) => {
  const semantic = convertLegacyModelRule(definition, reason);
  return {
    subject: semantic.subject,
    description: semantic.description,
    aliases: semantic.aliases ?? [],
    note: reason ?? '',
    enabled,
  };
};

export async function createModelRule(
  input: ModelRuleForm,
  userId: number
): Promise<WriteResult & { id: number }> {
  const definition = semanticModelRuleSchema.parse({
    type: 'semantic',
    subject: input.subject,
    description: input.description,
    aliases: input.aliases,
    updatedById: userId,
  });
  const now = new Date();
  const reason = input.note || null;
  const id = await dbWrite.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('ModerationRule')
      .values({
        entityType: 'Model',
        definition,
        action: 'Block',
        enabled: true,
        order: null,
        reason,
        createdById: userId,
        updatedAt: now,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await appendVersion(
      trx,
      created.id,
      null,
      { definition, enabled: true, action: 'Block', reason },
      userId
    );
    return created.id;
  });

  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: id,
    activity: 'create',
  });
  return { id, cacheStale };
}

/** Edits one rule, keeping `legacyMatch` and clearing `needsAttention` — saving is the act of reviewing. */
export async function updateModelRule(
  id: number,
  input: ModelRuleForm,
  userId: number,
  opts: { baseUpdatedAt?: string } = {}
): Promise<WriteResult> {
  await dbWrite.transaction().execute(async (trx) => {
    const existing = await lockRule(trx, id);
    if (!existing) throw new ModelRuleNotFoundError();
    if (!isSemanticDefinition(existing.definition)) throw new LegacyRuleError();
    if (opts.baseUpdatedAt !== undefined && existing.updatedAt.toISOString() !== opts.baseUpdatedAt)
      throw new ModelRuleStaleError();

    const definition = semanticModelRuleSchema.parse({
      type: 'semantic',
      subject: input.subject,
      description: input.description,
      aliases: input.aliases,
      ...(existing.definition.legacyMatch === undefined
        ? {}
        : { legacyMatch: existing.definition.legacyMatch }),
      updatedById: userId,
    });
    const reason = input.note || null;
    await trx
      .updateTable('ModerationRule')
      .set({ definition, reason, updatedAt: new Date() })
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
    await appendVersion(
      trx,
      id,
      existing,
      { definition, enabled: existing.enabled, action: existing.action, reason },
      userId
    );
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
    const existing = await lockRule(trx, id);
    if (!existing) throw new ModelRuleNotFoundError();
    const definition = isSemanticDefinition(existing.definition)
      ? { ...existing.definition, updatedById: userId }
      : existing.definition;
    await trx
      .updateTable('ModerationRule')
      .set({ enabled, updatedAt: new Date(), definition })
      .where('id', '=', id)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
    await appendVersion(
      trx,
      id,
      existing,
      { definition, enabled, action: existing.action, reason: existing.reason },
      userId
    );
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

export async function listModelRuleVersions(
  ruleId: number,
  limit = 50
): Promise<ModelRuleVersionView[]> {
  const rows = await dbWrite
    .selectFrom('ModerationRuleVersion as v')
    .innerJoin('ModerationRule as r', 'r.id', 'v.ruleId')
    .select(['v.id', 'v.definition', 'v.enabled', 'v.reason', 'v.createdById', 'v.createdAt'])
    .where('v.ruleId', '=', ruleId)
    .where('r.entityType', '=', 'Model')
    .orderBy('v.id', 'desc')
    .limit(limit)
    .execute();
  const users = await usersByIds(rows.map((row) => row.createdById));
  return rows.map((row) => ({
    id: row.id,
    legacy: !isSemanticDefinition(row.definition),
    ...viewOf(row.definition, row.reason, row.enabled),
    createdById: row.createdById,
    createdBy: users.get(row.createdById)?.username ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Writes an old version's definition and enabled state as the rule's new state, and as a new version. */
export async function restoreModelRuleVersion(
  ruleId: number,
  versionId: number,
  userId: number
): Promise<WriteResult> {
  await dbWrite.transaction().execute(async (trx) => {
    const existing = await lockRule(trx, ruleId);
    if (!existing) throw new ModelRuleNotFoundError();
    if (!isSemanticDefinition(existing.definition)) throw new LegacyRuleError();
    const version = await trx
      .selectFrom('ModerationRuleVersion')
      .select(['definition', 'enabled', 'reason'])
      .where('id', '=', versionId)
      .where('ruleId', '=', ruleId)
      .executeTakeFirst();
    if (!version) throw new ModelRuleVersionNotFoundError();
    if (!isSemanticDefinition(version.definition))
      throw new RestoreRefusedError('That version is a regex rule and cannot be restored.');
    if (
      sameRuleState(
        viewOf(existing.definition, existing.reason, existing.enabled),
        viewOf(version.definition, version.reason, version.enabled)
      )
    )
      throw new RestoreRefusedError('That version is the same as the current rule.');

    const definition = semanticModelRuleSchema.parse({
      ...version.definition,
      updatedById: userId,
    });
    await trx
      .updateTable('ModerationRule')
      .set({ definition, enabled: version.enabled, reason: version.reason, updatedAt: new Date() })
      .where('id', '=', ruleId)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
    await appendVersion(
      trx,
      ruleId,
      existing,
      { definition, enabled: version.enabled, action: existing.action, reason: version.reason },
      userId
    );
  });

  const cacheStale = !(await bustCache());
  await recordModActivity({
    userId,
    entityType: ACTIVITY_ENTITY,
    entityId: ruleId,
    activity: 'restore',
  });
  return { cacheStale };
}

export const MATCH_MODES = ['all', 'shadow', 'active'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

const ENTITY_TYPES: Record<MatchMode, readonly string[]> = {
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
 * Ordered by verdict time; the cursor is the last row's `updatedAt` as Postgres prints it, so it
 * round-trips without a timezone conversion. A row matches when the model matched a rule
 * (`modelRules`) or the text names one literally (`modelRulesLiteral`). The entity type, status and
 * label filters are SQL literals, not bound parameters: the planner can only use the partial index
 * `EntityModeration_modelRules_matches_idx` when the query repeats its predicate as literals.
 */
export async function getModelRuleMatches({
  mode,
  ruleId,
  cursor,
  limit,
}: {
  mode: MatchMode;
  ruleId?: number;
  cursor?: string;
  limit: number;
}): Promise<{ items: ModelRuleMatchRow[]; nextCursor?: string }> {
  let query = dbRead
    .selectFrom('EntityModeration as em')
    .leftJoin('Model as m', 'm.id', 'em.entityId')
    .select([
      'em.id',
      'em.entityType',
      'em.entityId',
      'em.updatedAt',
      sql<string>`em."updatedAt"::text`.as('updatedAtText'),
      'em.result',
      'm.name as modelName',
    ])
    .where(
      sql<boolean>`em."entityType" IN (${sql.join(ENTITY_TYPES[mode].map((t) => sql.lit(t)))})`
    )
    .where(sql<boolean>`em.status = 'Succeeded'`)
    .where(
      sql<boolean>`('modelRules' = ANY(em."triggeredLabels") OR 'modelRulesLiteral' = ANY(em."triggeredLabels"))`
    );
  if (ruleId !== undefined)
    query = query.where(
      sql<boolean>`(em.result #> '{labels,modelRules,matched}' @> ${JSON.stringify([
        { ruleId },
      ])}::jsonb OR em.result #> '{modelRules,literalRuleIds}' @> ${JSON.stringify([
        ruleId,
      ])}::jsonb)`
    );
  const after = parseMatchCursor(cursor);
  if (after)
    query = query.where(
      sql<boolean>`(em."updatedAt", em.id) < (${after.updatedAt}::timestamp, ${after.id})`
    );

  const rows = await query
    .orderBy('em.updatedAt', 'desc')
    .orderBy('em.id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = takePage(rows, limit, (r) => `${r.updatedAtText}|${r.id}`);
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
