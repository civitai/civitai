// No `$app/*` imports: the pglite suite loads this module without the SvelteKit runtime.
import { sql } from 'kysely';
import {
  MODEL_RULES_HOLD_LABEL,
  parseModelRulesHoldMeta,
  type ModelRulesHoldField,
  type ModelRulesHoldMatch,
  type StoredModelRuleSnapshot,
} from '@civitai/moderation/model-rules';
import {
  holdClearsRules,
  type HoldMode,
  type ModelRuleHoldFilters,
  type ModelRuleHoldModeFilter,
  type ModelRuleHoldStatusFilter,
} from '$lib/model-rule-holds';
import { dbRead } from './db';
import { escapeLike } from './like';
import { MAX_INT4 } from './users.service';

export type ModelRuleHoldSearch = { id: number } | { username: string };

export const modelRuleHoldSearch = (q: string): ModelRuleHoldSearch | undefined => {
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return { id: Number(q) > MAX_INT4 ? 0 : Number(q) };
  return { username: q };
};

export type ModelRuleHoldQuery = ModelRuleHoldFilters & {
  limit: number;
  offset: number;
  search?: ModelRuleHoldSearch;
  /** Only this owner's holds, which `search` by id would mix with holds on a model of that id. */
  owner?: number;
};

export type ModelRuleHoldRow = {
  id: number;
  modelId: number;
  userId: number | null;
  username: string | null;
  modelName: string | null;
  modelStatus: string | null;
  modelType: string | null;
  /** `Trained` when the model was trained on Civitai. */
  uploadType: string | null;
  /** `training` when a training run, not a publish or an edit, raised the hold. */
  source: 'training' | null;
  /** A ruling clears the matched rules for the text instead of restoring the model. */
  clearsRules: boolean;
  poi: boolean;
  minor: boolean;
  textHash: string;
  createdAt: Date;
  status: string;
  decidedAt: Date | null;
  decidedByUsername: string | null;
  decisionNote: string | null;
  decision: string | null;
  mode: HoldMode;
  /** Auto: the model was taken down at detection and has not been put back. */
  applied: boolean;
  hiddenAt: Date | null;
  restoredAt: Date | null;
  fields: ModelRulesHoldField[];
  matches: ModelRulesHoldMatch[];
  rules: StoredModelRuleSnapshot[];
  redetected: boolean;
  priorHoldId: number | null;
  /** Other pending model-rule holds by the same owner, across the whole queue. */
  otherPendingByOwner: number;
  /** Other models of the owner with a model-rule hold in any state. */
  otherHeldModels: number;
  /** The newest finished scan of the model read different text than this pending hold holds. */
  editedSince: boolean;
};

const STATUS_COLUMN = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
} as const;

// A duplicate or edited-away hold closed without a ruling is not history.
const notSuperseded = sql<boolean>`h.meta->>'decision' is distinct from 'superseded'`;
const holdMode = sql<string>`coalesce(h.meta->>'mode', 'shadow')`;

const modelRuleHolds = ({
  status,
  mode,
  rule,
  search,
  owner,
}: {
  status: ModelRuleHoldStatusFilter;
  mode: ModelRuleHoldModeFilter;
  rule?: number | null;
  search?: ModelRuleHoldSearch;
  owner?: number;
}) => {
  let query = dbRead
    .selectFrom('TextScanHold as h')
    .leftJoin('User as u', 'u.id', 'h.userId')
    .where('h.label', '=', MODEL_RULES_HOLD_LABEL)
    .where(notSuperseded);
  if (status !== 'all') query = query.where('h.status', '=', STATUS_COLUMN[status]);
  if (mode !== 'all')
    query = query.where(sql<boolean>`${holdMode} = ${mode === 'auto' ? 'active' : 'shadow'}`);
  if (owner !== undefined) query = query.where('h.userId', '=', owner);
  if (rule !== undefined && rule !== null)
    query = query.where(sql<boolean>`h.meta->'rules' @> ${JSON.stringify([{ id: rule }])}::jsonb`);
  if (search && 'id' in search)
    query = query.where((eb) =>
      eb.or([eb('h.entityId', '=', search.id), eb('h.userId', '=', search.id)])
    );
  else if (search)
    query = query.where(
      sql<boolean>`lower(u.username) like lower(${escapeLike(search.username) + '%'})`
    );
  return query;
};

export async function listModelRuleHolds({
  limit,
  offset,
  status,
  mode,
  sort,
  rule,
  search,
  owner,
}: ModelRuleHoldQuery): Promise<{ items: ModelRuleHoldRow[]; hasMore: boolean }> {
  const rows = await modelRuleHolds({ status, mode, rule, search, owner })
    .leftJoin('User as d', 'd.id', 'h.decidedById')
    .leftJoin('Model as m', 'm.id', 'h.entityId')
    .select([
      'h.id',
      'h.entityId',
      'h.userId',
      'u.username',
      'h.textHash',
      'h.createdAt',
      'h.status',
      'h.decidedAt',
      'd.username as decidedByUsername',
      'h.decisionNote',
      'h.hiddenAt',
      'h.restoredAt',
      'h.meta',
      'm.name as modelName',
      sql<string | null>`m.status::text`.as('modelStatus'),
      sql<string | null>`m.type::text`.as('modelType'),
      sql<string | null>`m."uploadType"::text`.as('uploadType'),
      sql<string | null>`m.availability::text`.as('modelAvailability'),
      sql<boolean>`m."deletedAt" is not null`.as('modelDeleted'),
      sql<boolean>`coalesce(m.poi, false)`.as('poi'),
      sql<boolean>`coalesce(m.minor, false)`.as('minor'),
      sql<number>`case when h.status = 'Pending' and h."userId" is not null then (
        select count(*)::int from "TextScanHold" x
        where x."userId" = h."userId" and x.label = ${MODEL_RULES_HOLD_LABEL}
          and x.status = 'Pending' and x.id <> h.id
      ) else 0 end`.as('otherPendingByOwner'),
      sql<number>`case when h."userId" is not null then (
        select count(distinct x."entityId")::int from "TextScanHold" x
        where x."userId" = h."userId" and x.label = ${MODEL_RULES_HOLD_LABEL}
          and x."entityId" <> h."entityId" and x.meta->>'decision' is distinct from 'superseded'
      ) else 0 end`.as('otherHeldModels'),
      // Compared with the hold's own hash: a scan of other text means the model was edited after the hold.
      sql<boolean>`h.status = 'Pending' and coalesce((
        select em.result->>'textHash' <> h."textHash" from "EntityModeration" em
        where em."entityId" = h."entityId" and em."entityType" in ('Model', 'Model:shadow')
          and em.status::text = 'Succeeded' and em.result->>'textHash' is not null
        order by em."updatedAt" desc, em.id desc limit 1
      ), false)`.as('editedSince'),
    ])
    .orderBy('h.createdAt', sort === 'newest' ? 'desc' : 'asc')
    .orderBy('h.id', sort === 'newest' ? 'desc' : 'asc')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const items = rows
    .slice(0, limit)
    .map(({ meta, entityId, modelAvailability, modelDeleted, ...row }): ModelRuleHoldRow => {
      const parsed = parseModelRulesHoldMeta(meta);
      return {
        ...row,
        modelId: entityId,
        username: row.username ?? null,
        modelName: row.modelName ?? null,
        decidedByUsername: row.decidedByUsername ?? null,
        mode: parsed.mode,
        decision: parsed.decision ?? null,
        applied: row.hiddenAt !== null && row.restoredAt === null,
        fields: parsed.fields,
        matches: parsed.matches,
        rules: parsed.rules,
        redetected: parsed.kind === 'redetected' && parsed.priorHoldId !== undefined,
        priorHoldId: parsed.priorHoldId ?? null,
        source: parsed.source ?? null,
        clearsRules: holdClearsRules({
          source: parsed.source ?? null,
          modelStatus: row.modelStatus,
          modelAvailability,
          modelDeleted,
        }),
      };
    });
  return { items, hasMore: rows.length > limit };
}

export async function countPendingModelRuleHolds(): Promise<number> {
  const row = await modelRuleHolds({ status: 'pending', mode: 'all' })
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Holds per matched rule under the status and mode filters (a multi-rule hold counts once per rule), most first. */
export async function countModelRuleHoldsByRule(args: {
  status: ModelRuleHoldStatusFilter;
  mode: ModelRuleHoldModeFilter;
  owner?: number;
}): Promise<{ id: number; subject: string; count: number }[]> {
  const { rows } = await sql<{ id: number; subject: string; count: number }>`
    select (r->>'id')::int as id, max(r->>'subject') as subject, count(distinct h.id)::int as count
    from (${modelRuleHolds(args).select(['h.id', 'h.meta'])}) h
    cross join lateral jsonb_array_elements(case when jsonb_typeof(h.meta->'rules') = 'array' then h.meta->'rules' else '[]'::jsonb end) r
    where r->>'id' ~ '^[0-9]{1,9}$'
    group by 1
    order by count desc, id asc`.execute(dbRead);
  return rows;
}

export type ModelRuleHoldHistoryEntry = {
  id: number;
  status: string;
  decision: string | null;
  mode: HoldMode;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByUsername: string | null;
  decisionNote: string | null;
  subjects: string[];
  /** Its ruling cleared the matched rules for the text instead of restoring the model. */
  clearsRules: boolean;
};

/** The other holds on the hold's model, newest first. */
export async function getModelRuleHoldHistory(
  holdId: number
): Promise<ModelRuleHoldHistoryEntry[]> {
  const rows = await dbRead
    .selectFrom('TextScanHold as h')
    .innerJoin('TextScanHold as self', (join) =>
      join.onRef('self.entityId', '=', 'h.entityId').on('self.entityType', '=', 'Model')
    )
    .leftJoin('User as d', 'd.id', 'h.decidedById')
    .leftJoin('Model as m', 'm.id', 'h.entityId')
    .select([
      'h.id',
      'h.status',
      'h.createdAt',
      'h.decidedAt',
      'd.username as decidedByUsername',
      'h.decisionNote',
      'h.meta',
      sql<string | null>`m.status::text`.as('modelStatus'),
      sql<string | null>`m.availability::text`.as('modelAvailability'),
      sql<boolean>`m."deletedAt" is not null`.as('modelDeleted'),
    ])
    .where('self.id', '=', holdId)
    .where('h.entityType', '=', 'Model')
    .where('h.label', '=', MODEL_RULES_HOLD_LABEL)
    .where('h.id', '<>', holdId)
    .where(notSuperseded)
    .orderBy('h.createdAt', 'desc')
    .orderBy('h.id', 'desc')
    .limit(20)
    .execute();
  return rows.map(({ meta, modelStatus, modelAvailability, modelDeleted, ...row }) => {
    const parsed = parseModelRulesHoldMeta(meta);
    return {
      ...row,
      clearsRules: holdClearsRules({
        source: parsed.source ?? null,
        modelStatus,
        modelAvailability,
        modelDeleted,
      }),
      decidedByUsername: row.decidedByUsername ?? null,
      decision: parsed.decision ?? null,
      mode: parsed.mode,
      subjects: parsed.rules.map((rule) => rule.subject),
    };
  });
}

export type OwnerRuleHolds = {
  userId: number;
  /** The owner's other pending holds, each with the hash a batch decision has to echo back. */
  pending: { id: number; modelId: number; modelName: string | null; textHash: string }[];
};

export const OWNER_PENDING_READ_MAX = 500;

/** The hold's owner's other pending model-rule holds; null when the hold is missing or has no recorded owner. */
export async function getOwnerRuleHolds(holdId: number): Promise<OwnerRuleHolds | null> {
  const hold = await dbRead
    .selectFrom('TextScanHold')
    .select(['userId', 'entityId'])
    .where('id', '=', holdId)
    .where('label', '=', MODEL_RULES_HOLD_LABEL)
    .executeTakeFirst();
  const userId = hold?.userId;
  if (!userId) return null;

  const others = () =>
    dbRead
      .selectFrom('TextScanHold as h')
      .where('h.userId', '=', userId)
      .where('h.label', '=', MODEL_RULES_HOLD_LABEL)
      .where('h.entityId', '<>', hold.entityId)
      .where(notSuperseded);
  const pending = await others()
    .leftJoin('Model as m', 'm.id', 'h.entityId')
    .select(['h.id', 'h.entityId as modelId', 'm.name as modelName', 'h.textHash'])
    .where('h.status', '=', 'Pending')
    .orderBy('h.createdAt', 'desc')
    .orderBy('h.id', 'desc')
    .limit(OWNER_PENDING_READ_MAX)
    .execute();
  return {
    userId,
    pending: pending.map((row) => ({ ...row, modelName: row.modelName ?? null })),
  };
}

/** Of `ids`, the pending model-rule holds of the same owner as `holdId`, with the model each sits on. */
export async function filterOwnerPendingHolds(
  holdId: number,
  ids: number[]
): Promise<{ id: number }[]> {
  if (!ids.length) return [];
  return dbRead
    .selectFrom('TextScanHold as h')
    .innerJoin('TextScanHold as o', 'o.userId', 'h.userId')
    .select('o.id')
    .where('h.id', '=', holdId)
    .where('h.label', '=', MODEL_RULES_HOLD_LABEL)
    .where('o.label', '=', MODEL_RULES_HOLD_LABEL)
    .where('o.status', '=', 'Pending')
    .where('o.id', '<>', holdId)
    .where('o.id', 'in', ids)
    .execute();
}
