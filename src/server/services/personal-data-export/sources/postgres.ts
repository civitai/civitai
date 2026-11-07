import { Prisma } from '@prisma/client';
import type { PoolClient } from 'pg';
import {
  STAFF_NAME_RE,
  STAFF_PLACEHOLDER,
  columnDecision,
  reduceTriggers,
  redactStaff,
  scrubJson,
  type ColumnDecision,
} from '../column-policy';
import { csvFile, type ExportWriter, type ManifestFile } from '../output';
import { REGISTRY, type RegistryEntry } from '../registry';

/** Rows fetched per round trip from a table's cursor. */
export const PG_FETCH_SIZE = 500;
/** Per-statement limit: one FETCH, not the whole table. */
export const PG_STATEMENT_TIMEOUT_MS = 120_000;
/**
 * A table whose subject column leads no index is read only below this estimated size; above it the
 * read would be a full scan of a large table, and the manifest says the table was not read.
 */
export const PG_UNINDEXED_ROW_LIMIT = 5_000_000;

type Column = {
  field: string;
  db: string;
  type: string;
  decision: ColumnDecision;
  role: 'subject' | 'staff' | 'others' | null;
};

export type PgTablePlan = {
  /** File name under data/postgres/, without the extension. */
  name: string;
  model: string;
  table: string;
  /** Read columns, in output order. Credential and classifier columns are not in it. */
  columns: Column[];
  /** Staff-written columns, read into the separate notes file and never written to this one. */
  noteColumns: Column[];
  /** Read for a row rule, never written (see RULE_ONLY_COLUMNS). */
  ruleColumns: Column[];
  /** The WHERE clause over the table, the user id inlined (proven a positive integer). */
  where: string;
  /** Subject columns whose index the read relies on (for the unindexed check). */
  subjectColumns: string[];
  rule?: RegistryEntry['rule'];
  description: string;
};

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

const modelsByName = () => new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function assertUserId(userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error(`Refusing to export for user id ${String(userId)}`);
}

function columnsOf(model: DmmfModel, entry: Pick<RegistryEntry, 'subject' | 'staff' | 'others'>) {
  const all: Column[] = model.fields
    .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
    .map((f) => ({
      field: f.name,
      db: f.dbName ?? f.name,
      type: f.type,
      decision: columnDecision(model.name, f.name, f.type),
      role: entry.subject.includes(f.name)
        ? 'subject'
        : entry.staff?.includes(f.name)
        ? 'staff'
        : entry.others?.includes(f.name)
        ? 'others'
        : null,
    }));
  return {
    columns: all.filter((c) => c.decision === 'read'),
    noteColumns: all.filter((c) => c.decision === 'note'),
    ruleColumns: all.filter((c) => c.decision === 'rule-only'),
  };
}

function subjectWhere(model: DmmfModel, subject: readonly string[], userId: number) {
  const parts = subject.map((name) => {
    const f = model.fields.find((x) => x.name === name);
    if (!f) throw new Error(`${model.name}.${name} is not a field`);
    const value = f.type === 'String' ? `'${userId}'` : String(userId);
    return `${q(f.dbName ?? f.name)} = ${value}`;
  });
  return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
}

/**
 * Images the content-safety rules leave out of an export, rows and URLs both; kept at least as wide
 * as `excludedImageRow`. Accounts under a legal hold are handled by `exportHoldReasons`. Over
 * "Image" unaliased.
 */
export const IMAGE_SAFETY_CONDITION = `(
  COALESCE("Image"."blockedFor", '') = 'CSAM'
  OR COALESCE("Image"."needsReview", '') IN ('csam', 'minor')
  OR ("Image"."minor" AND ("Image"."ingestion" = 'Blocked' OR "Image"."blockedFor" IS NOT NULL))
  OR "Image"."userId" IN (SELECT c."userId" FROM "CsamReport" c WHERE c."userId" IS NOT NULL)
  OR "Image".id IN (
    SELECT (e ->> 'id')::bigint
    FROM "CsamReport" c
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.images) = 'array' THEN c.images ELSE '[]'::jsonb END
    ) e
    WHERE (e ->> 'id') ~ '^[0-9]{1,18}$'
  )
)`;
export const IMAGE_SAFETY_EXCLUSION = `NOT ${IMAGE_SAFETY_CONDITION}`;

const tableOf = (m: DmmfModel) => m.dbName ?? m.name;

/** Rows related to the user through another table, which the registry cannot express. */
function relatedPlans(models: Map<string, DmmfModel>, userId: number): PgTablePlan[] {
  const plan = (
    name: string,
    modelName: string,
    where: string,
    description: string,
    entry: Pick<RegistryEntry, 'subject' | 'staff' | 'others'> = { subject: [] },
    only?: string[]
  ): PgTablePlan => {
    const model = models.get(modelName);
    if (!model) throw new Error(`No model ${modelName}`);
    const { columns, noteColumns, ruleColumns } = columnsOf(model, entry);
    return {
      name,
      model: modelName,
      table: tableOf(model),
      columns: only ? columns.filter((c) => only.includes(c.field)) : columns,
      noteColumns: only ? [] : noteColumns,
      ruleColumns: only ? [] : ruleColumns,
      where,
      subjectColumns: [],
      description,
    };
  };
  const ownModels = `SELECT id FROM "Model" WHERE "userId" = ${userId}`;
  return [
    // The account row has no user-id column of its own: its key is the id.
    plan('User', 'User', `id = ${userId}`, 'Your account.'),
    plan(
      'ModelVersion',
      'ModelVersion',
      `"modelId" IN (${ownModels})`,
      'Versions of models you created.'
    ),
    plan(
      'ModelFile',
      'ModelFile',
      `"modelVersionId" IN (SELECT mv.id FROM "ModelVersion" mv WHERE mv."modelId" IN (${ownModels}))`,
      'Files of models you created.'
    ),
    plan(
      'ChatMessage.received',
      'ChatMessage',
      // What the chat shows the member, the same window the chat reader applies
      // (getInfiniteMessagesHandler in chat.controller.ts): not deleted; before they left or were kicked; nothing
      // while ignoring it; and after they last cleared it.
      `"userId" <> ${userId} AND "deletedAt" IS NULL AND EXISTS (
        SELECT 1 FROM "ChatMember" cm
        WHERE cm."chatId" = "ChatMessage"."chatId" AND cm."userId" = ${userId}
          AND cm.status <> 'Ignored'
          AND (cm.status <> 'Left' OR "ChatMessage"."createdAt" < cm."leftAt")
          AND (cm.status <> 'Kicked' OR "ChatMessage"."createdAt" < cm."kickedAt")
          AND (cm."clearedAt" IS NULL OR "ChatMessage"."createdAt" > cm."clearedAt")
      )`,
      'Messages other users sent you in chats you are a member of, as the chat shows them. The sender is given by user id.',
      { subject: [], others: ['userId'] },
      ['id', 'chatId', 'userId', 'content', 'contentType', 'createdAt', 'editedAt', 'deletedAt']
    ),
    plan(
      'Report.aboutYou',
      'Report',
      // Decided reports only: an open one is not yet a decision about the account.
      `id IN (SELECT "reportId" FROM "UserReport" WHERE "userId" = ${userId}) AND status IN ('Actioned', 'Unactioned')`,
      'Decided reports about your account: reason, date and outcome. Who reported is not included.',
      { subject: [] },
      ['id', 'reason', 'createdAt', 'status', 'statusSetAt']
    ),
  ];
}

/** Every Postgres read an export makes, in order. Pure: no database access. */
export function planPostgresExport(userId: number): PgTablePlan[] {
  assertUserId(userId);
  const models = modelsByName();
  const plans: PgTablePlan[] = [];
  for (const [modelName, entry] of Object.entries(REGISTRY)) {
    const model = models.get(modelName);
    if (!model) throw new Error(`Registry names ${modelName}, which is not a model`);
    if (!entry.subject.length) throw new Error(`Registry entry ${modelName} has no subject column`);
    const { columns, noteColumns, ruleColumns } = columnsOf(model, entry);
    let where = subjectWhere(model, entry.subject, userId);
    if (entry.rule === 'image-media') where = `${where} AND ${IMAGE_SAFETY_EXCLUSION}`;
    plans.push({
      name: modelName,
      model: modelName,
      table: tableOf(model),
      columns,
      noteColumns,
      ruleColumns,
      where,
      subjectColumns: entry.subject.map((s) => model.fields.find((f) => f.name === s)?.dbName ?? s),
      rule: entry.rule,
      description: `${modelName} records where you are the ${entry.subject.join(' or ')}.`,
    });
  }
  plans.push(...relatedPlans(models, userId));
  return plans;
}

export function selectSql(plan: PgTablePlan): string {
  const cols = [...plan.columns, ...plan.noteColumns, ...plan.ruleColumns].map((c) =>
    c.db === c.field ? q(c.db) : `${q(c.db)} AS ${q(c.field)}`
  );
  // Collaborators exist only on posts (entity-collaborator.service.ts refuses any other type).
  if (plan.model === 'EntityCollaborator')
    cols.push(
      `(SELECT p."userId" FROM "Post" p WHERE ${q(plan.table)}."entityType" = 'Post'
         AND p.id = ${q(plan.table)}."entityId") AS ${q(ENTITY_OWNER)}`
    );
  return `SELECT ${cols.join(', ')} FROM ${q(plan.table)} WHERE ${plan.where}`;
}

const REMOVED = 'removed';
/** Read alongside a collaborator row to tell its owner from staff; never written. */
const ENTITY_OWNER = 'entityOwnerId';

/** One row as written: staff ids redacted, JSON scrubbed, the table's rule applied, notes split off. */
export function transformRow(
  plan: PgTablePlan,
  row: Record<string, unknown>,
  userId: number
): { out: Record<string, unknown>; notes: { column: string; text: string }[] } {
  const out: Record<string, unknown> = {};
  for (const c of plan.columns) {
    let v = row[c.field];
    if (c.role === 'staff' || (c.role === null && c.type === 'Int' && STAFF_NAME_RE.test(c.field)))
      v = redactStaff(v, userId);
    else if (c.type === 'Json') v = scrubJson(v);
    out[c.field] = v;
  }
  // An anonymous gift does not name its gifter to anyone but the gifter.
  if (plan.model === 'MembershipGift' && row.anonymous === true && Number(row.gifterId) !== userId)
    for (const k of ['gifterId', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'amountCents'])
      if (k in out) out[k] = null;
  // A placement's resolver is the owner, except when staff removed it.
  if (plan.model === 'Placement' && out.resolvedById != null) {
    const byStaff = row.removedBy === 'moderator' || row.removedBy === 'cosmeticTakedown';
    if (byStaff || Number(row.resolvedById) !== Number(row.ownerId))
      out.resolvedById = STAFF_PLACEHOLDER;
  }
  // The post's owner adds its collaborators, or a moderator does for them.
  if (plan.model === 'EntityCollaborator' && out.createdBy != null) {
    const by = Number(out.createdBy);
    const owner = row[ENTITY_OWNER];
    if (by !== userId && owner == null) out.createdBy = null;
    else if (by !== userId && by !== Number(owner)) out.createdBy = STAFF_PLACEHOLDER;
  }
  if (plan.rule === 'image-media') {
    const removed =
      row.ingestion === 'Blocked' || row.tosViolation === true || row.blockedFor != null;
    if (removed) out.url = REMOVED;
  }
  if (plan.rule === 'restriction-triggers' && 'triggers' in out)
    out.triggers = reduceTriggers(row.triggers);
  const notes: { column: string; text: string }[] = [];
  for (const c of plan.noteColumns) {
    const v = row[c.field];
    if (typeof v === 'string' && v.trim()) notes.push({ column: c.field, text: v });
  }
  return { out, notes };
}

export type PgNote = {
  table: string;
  column: string;
  rowId: unknown;
  createdAt: unknown;
  text: string;
};

type Connect = () => Promise<Pick<PoolClient, 'query' | 'release'>>;

/** Which subject columns lead an index, and each table's estimated size. One catalog query. */
async function indexState(client: Pick<PoolClient, 'query'>, plans: PgTablePlan[]) {
  const tables = [...new Set(plans.filter((p) => p.subjectColumns.length).map((p) => p.table))];
  const { rows } = await client.query<{ table: string; column: string; est: string }>(
    `SELECT cl.relname AS "table", a.attname AS "column", cl.reltuples::bigint::text AS est
       FROM pg_class cl
       JOIN pg_index i ON i.indrelid = cl.oid
       JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = i.indkey[0]
      WHERE cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1)
     UNION ALL
     SELECT cl.relname, NULL, cl.reltuples::bigint::text
       FROM pg_class cl
      WHERE cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY($1)`,
    [tables]
  );
  const indexed = new Set(rows.filter((r) => r.column).map((r) => `${r.table}.${r.column}`));
  const est = new Map(rows.filter((r) => !r.column).map((r) => [r.table, Number(r.est)]));
  return (plan: PgTablePlan) =>
    plan.subjectColumns.every((c) => indexed.has(`${plan.table}.${c}`)) ||
    (est.get(plan.table) ?? 0) < PG_UNINDEXED_ROW_LIMIT;
}

/**
 * Streams every planned table into `data/postgres/<name>.csv` through a server-side cursor, one
 * read-only transaction per table, so no table is held in memory and a failure in one table does
 * not stop the rest. An empty table writes no file; its zero is still in the manifest.
 */
export async function exportPostgres({
  userId,
  writer,
  connect,
  onNote,
  onError,
}: {
  userId: number;
  writer: ExportWriter;
  connect: Connect;
  onNote: (note: PgNote) => void;
  onError: (table: string, e: unknown) => void;
}): Promise<{ files: ManifestFile[]; noteCount: number }> {
  const plans = planPostgresExport(userId);
  const files: ManifestFile[] = [];
  let noteCount = 0;

  const client = await connect();
  try {
    const readable = await indexState(client, plans);
    for (const plan of plans) {
      const file = `data/postgres/${plan.name}.csv`;
      const entry: ManifestFile = {
        file,
        source: 'postgres',
        rows: 0,
        description: plan.description,
        status: 'complete',
        columns: plan.columns.map((c) => c.field),
      };
      files.push(entry);
      if (!readable(plan)) {
        entry.status = 'not-included';
        continue;
      }
      const fetchPage = async () =>
        (await client.query(`FETCH ${PG_FETCH_SIZE} FROM export_cursor`)).rows as Record<
          string,
          unknown
        >[];

      // Up to the first page, a failure costs this table only: it is marked unavailable and the
      // export goes on. Once its file has started, a failure breaks the archive itself, so it is
      // rethrown and the whole attempt fails (and is retried).
      let first: Record<string, unknown>[];
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${PG_STATEMENT_TIMEOUT_MS}`);
        await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR ${selectSql(plan)}`);
        first = await fetchPage();
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        entry.status = 'unavailable';
        onError(plan.name, e);
        continue;
      }

      try {
        if (first.length) {
          const pages = async function* () {
            let page = first;
            while (page.length) {
              yield page.map((row) => {
                const { out, notes } = transformRow(plan, row, userId);
                for (const n of notes) {
                  noteCount++;
                  onNote({
                    table: plan.model,
                    column: n.column,
                    rowId: row.id,
                    createdAt: row.createdAt,
                    text: n.text,
                  });
                }
                return out;
              });
              if (page.length < PG_FETCH_SIZE) break;
              page = await fetchPage();
            }
          };
          await writer.addFile(
            file,
            csvFile(entry.columns ?? [], pages(), () => entry.rows++)
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    }
  } finally {
    client.release();
  }
  return { files, noteCount };
}
