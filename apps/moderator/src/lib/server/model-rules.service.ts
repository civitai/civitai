import { sql, type Insertable, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import {
  MODEL_RULES_HOLD_LABEL,
  readModelRuleExtras,
  type ModelRuleCategory,
  type ModelRuleReference,
} from '@civitai/moderation/model-rules';
import { convertLegacyModelRule } from '@civitai/moderation/model-rules-convert';
import {
  isSemanticDefinition,
  semanticModelRuleSchema,
  type ModelRuleForm,
} from '$lib/model-rules';
import { sameRuleState, type ModelRuleVersionView } from '$lib/model-rule-versions';
import { bustKeyBestEffort } from './cache';
import { dbRead, dbWrite } from './db';
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

/** The tail of every rule write: clear the rules cache, then log the activity. */
async function afterRuleWrite(
  userId: number,
  ruleId: number,
  activity: string
): Promise<WriteResult> {
  const cacheStale = !(await bustCache());
  await recordModActivity({ userId, entityType: ACTIVITY_ENTITY, entityId: ruleId, activity });
  return { cacheStale };
}

export type ModelRuleView = {
  id: number;
  legacy: boolean;
  subject: string;
  description: string;
  aliases: string[];
  category?: ModelRuleCategory;
  references: ModelRuleReference[];
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
    ...readModelRuleExtras(semantic),
    needsAttention: !!semantic.needsAttention,
    enabled: row.enabled,
    note: row.reason ?? '',
    legacyMatch: semantic.legacyMatch === undefined ? null : prettyJson(semantic.legacyMatch),
    editedById,
    editedBy: users.get(editedById)?.username ?? null,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Model-rule holds dismissed as "not this subject", per matched rule. Reads the hold's rule snapshot,
 * the same field the review queue's rule filter uses, so a rule's count and its queue link agree.
 */
export async function countNotSubjectDismissalsByRule(): Promise<Record<number, number>> {
  const { rows } = await sql<{ id: number; count: number }>`
    select (r->>'id')::int as id, count(distinct h.id)::int as count
    from "TextScanHold" h
    cross join lateral jsonb_array_elements(case when jsonb_typeof(h.meta->'rules') = 'array' then h.meta->'rules' else '[]'::jsonb end) r
    where h.label = ${MODEL_RULES_HOLD_LABEL}
      and h.status = 'Dismissed'
      and h.meta->>'decision' = 'dismiss_not_subject'
      and r->>'id' ~ '^[0-9]{1,9}$'
    group by 1`.execute(dbRead);
  return Object.fromEntries(rows.map((row) => [row.id, row.count]));
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

export class RuleNeedsReviewError extends Error {
  constructor() {
    super('Review and save this rule before enabling it.');
    this.name = 'RuleNeedsReviewError';
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

/** Appends `next` to the rule's history. A rule from before history was kept gets its prior state recorded first. */
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
    ...readModelRuleExtras(semantic),
    note: reason ?? '',
    enabled,
    needsAttention: !!semantic.needsAttention,
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
    category: input.category,
    references: input.references,
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

  const { cacheStale } = await afterRuleWrite(userId, id, 'create');
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
      category: input.category,
      references: input.references,
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

  return afterRuleWrite(userId, id, 'edit');
}

export async function setModelRuleEnabled(
  id: number,
  enabled: boolean,
  userId: number
): Promise<WriteResult> {
  await dbWrite.transaction().execute(async (trx) => {
    const existing = await lockRule(trx, id);
    if (!existing) throw new ModelRuleNotFoundError();
    // The scan ignores a flagged rule, so enabling one would only look active.
    if (enabled && isSemanticDefinition(existing.definition) && existing.definition.needsAttention)
      throw new RuleNeedsReviewError();
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

  return afterRuleWrite(userId, id, enabled ? 'enable' : 'disable');
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

/** Writes an old version's definition and enabled state as the rule's new state, and as a new version. A version that needed attention comes back flagged and disabled. */
export async function restoreModelRuleVersion(
  ruleId: number,
  versionId: number,
  userId: number
): Promise<WriteResult & { flagged: boolean }> {
  let flagged = false;
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
    const parsed = semanticModelRuleSchema.safeParse({
      ...version.definition,
      updatedById: userId,
    });
    if (!parsed.success)
      throw new RestoreRefusedError(
        'That version no longer fits the rule format and cannot be restored.'
      );
    const definition = parsed.data;
    // A flagged rule is restored flagged, and so disabled: the same state the converter leaves it in.
    const enabled = version.enabled && !definition.needsAttention;
    flagged = !!definition.needsAttention;
    // Compared as it will land, not as the version recorded it: a flagged version lands disabled.
    if (
      sameRuleState(
        viewOf(existing.definition, existing.reason, existing.enabled),
        viewOf(version.definition, version.reason, enabled)
      )
    )
      throw new RestoreRefusedError('That version is the same as the current rule.');

    await trx
      .updateTable('ModerationRule')
      .set({ definition, enabled, reason: version.reason, updatedAt: new Date() })
      .where('id', '=', ruleId)
      .where('entityType', '=', 'Model')
      .executeTakeFirstOrThrow();
    await appendVersion(
      trx,
      ruleId,
      existing,
      { definition, enabled, action: existing.action, reason: version.reason },
      userId
    );
  });

  return { ...(await afterRuleWrite(userId, ruleId, 'restore')), flagged };
}
