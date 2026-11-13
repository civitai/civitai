import { sql, type Kysely, type SqlBool } from 'kysely';
import { closeOpenYesNoItem } from './close';
import { parseCsv } from './csv';
import type { DB } from '@civitai/db-schema/kysely';
import {
  isModeratedSql,
  MODERATION_META_KEY,
  MODERATOR_RETIRED,
  REWORD_OF_META_KEY,
  YESNO_QUESTION_MAX,
} from '@civitai/db/knights';
import {
  axisKey,
  axisPrompt,
  isAxis,
  YESNO_ANSWERS,
  YESNO_AUDIENCE,
  YESNO_CONSENSUS_VOTES,
  YESNO_MAX_VOTES,
  YESNO_SOURCE,
} from './keys';

export type YesNoRow = {
  externalId: string;
  imageId: number;
  axis: string;
  audience: string;
  prompt: string;
  yesEffect: string | null;
  noEffect: string | null;
  meta: Record<string, string>;
};

export type Skipped = Partial<
  Record<
    'inactive' | 'bad-id' | 'bad-image' | 'bad-axis' | 'bad-kind' | 'bad-question' | 'duplicate',
    number
  >
>;

const MAX_ID = 200;
/** `Image.id` is a Postgres `integer`; a larger id cannot exist, and binding it in a lookup would fail the whole chunk. */
const MAX_IMAGE_ID = 2_147_483_647;
const MAX_EFFECT = 40;
const META_COLUMNS = {
  caseId: 'case_id',
  kind: 'kind',
  purpose: 'source_purpose',
  batchId: 'source_batch_id',
  promotionStatus: 'promotion_status',
  policySha256: 'policy_sha256',
} as const;

const AUDIENCE_OF_KIND: Record<string, string> = {
  observable: YESNO_AUDIENCE.players,
  policy_preference: YESNO_AUDIENCE.moderators,
};

/** Written by the database so a script run on a laptop and one run on a server agree. tsx cannot import the `utc` helper from the workspace package. */
const utcNow = sql<Date>`(now() AT TIME ZONE 'utc')`;

/** An item the import closed as withdrawn. */
const retired = sql<SqlBool>`("KnightsQueueItem"."status" = 'Closed' AND "KnightsQueueItem"."reason" = 'retired')`;

/** Closed by a moderator. Unlike other moderated items, the import never reopens it. */
const moderatorRetired = sql<SqlBool>`("KnightsQueueItem"."reason" IS NOT DISTINCT FROM ${MODERATOR_RETIRED})`;

/** An id longer than the limit is rejected, not cut, so two long ids can never collapse into one. */
const idOf = (value: string | undefined): string => {
  const id = (value ?? '').trim();
  return id.length > MAX_ID ? '' : id;
};

const clip = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max);

/** Keeps the active candidates and checks each one; a row that fails is counted by reason, never echoed. */
export function toYesNoRows(records: Record<string, string>[]): {
  rows: YesNoRow[];
  skipped: Skipped;
  /** Ids of rows the producer no longer marks active; an open question with one of these is retired by the import. */
  retire: string[];
} {
  const retire: string[] = [];
  const skipped: Skipped = {};
  const skip = (reason: keyof Skipped) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const rows: YesNoRow[] = [];

  for (const r of records) {
    if ((r.active_candidate ?? '').trim().toLowerCase() !== 'true') {
      const id = idOf(r.question_id);
      if (id) retire.push(id);
      skip('inactive');
      continue;
    }
    const externalId = idOf(r.question_id);
    if (!externalId) {
      skip('bad-id');
      continue;
    }
    if (seen.has(externalId)) {
      skip('duplicate');
      continue;
    }
    const imageId = Number(r.image_id);
    if (!Number.isInteger(imageId) || imageId <= 0 || imageId > MAX_IMAGE_ID) {
      skip('bad-image');
      continue;
    }
    const axis = clip(r.axis, 60).toLowerCase();
    if (!isAxis(axis)) {
      skip('bad-axis');
      continue;
    }
    const audience = AUDIENCE_OF_KIND[clip(r.kind, 40)];
    if (!audience) {
      skip('bad-kind');
      continue;
    }
    const prompt = clip(r.question, YESNO_QUESTION_MAX);
    if (!prompt) {
      skip('bad-question');
      continue;
    }
    seen.add(externalId);
    rows.push({
      externalId,
      imageId,
      axis,
      audience,
      prompt,
      yesEffect: clip(r.yes_effect, MAX_EFFECT) || null,
      noEffect: clip(r.no_effect, MAX_EFFECT) || null,
      meta: {
        ...Object.fromEntries(
          Object.entries(META_COLUMNS).map(([name, column]) => [name, clip(r[column], 120)])
        ),
        // A cleaned-up CSV rewords a producer question under a new id; this links it back, the way a
        // moderator reword does. Left out when empty: the moderator tools treat any value as a reword.
        ...(idOf(r.reword_of) ? { [REWORD_OF_META_KEY]: idOf(r.reword_of) } : {}),
      },
    });
  }
  return { rows, skipped, retire };
}

/**
 * Drops the rows whose image is not in `Image`, counting each under `skipped['bad-image']`. Nothing references `Image`
 * from the queue, so an item for a missing image would be inserted and stay open, never served.
 */
export async function dropMissingImages(
  db: Kysely<DB>,
  rows: YesNoRow[],
  skipped: Skipped
): Promise<YesNoRow[]> {
  if (rows.length === 0) return rows;
  const found = await db
    .selectFrom('Image')
    .select('id')
    .where('id', 'in', [...new Set(rows.map((r) => r.imageId))])
    .execute();
  const existing = new Set(found.map((f) => f.id));
  const kept = rows.filter((r) => existing.has(r.imageId));
  const missing = rows.length - kept.length;
  if (missing > 0) skipped['bad-image'] = (skipped['bad-image'] ?? 0) + missing;
  return kept;
}

export type ImportResult = {
  inserted: number;
  /** Rows that already existed, had no answers yet, and differed. */
  updated: number;
  unchanged: number;
  /** Differ from what is stored but already have answers, so were left as they are. */
  refused: number;
  /** Unanswered rows skipped because a moderator acted on them. */
  moderated: number;
  /** Open questions the producer withdrew, closed with no outcome. */
  retired: number;
  /** Reworded copies reopened because the file lists their moderator-retired original again. */
  revived: number;
  axes: number;
};

/** One line with every count, so a missing field can never print as a blank. */
export function formatImportSummary(result: ImportResult): string {
  return `${result.axes} axes; ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.refused} refused (changed but already answered), ${result.moderated} skipped (moderated), ${result.retired} retired, ${result.revived} reworded copies reopened.`;
}

/**
 * Upserts questions by their producer id. An item that already has answers is never touched, so a re-import cannot change
 * what a recorded answer was an answer to. The axis questions are created once and never overwritten (their consensus size is tuned in the table).
 */
export async function importYesNo(
  db: Kysely<DB>,
  rows: YesNoRow[],
  {
    batchSize = 1000,
    retire = [],
    now = new Date(),
  }: { batchSize?: number; retire?: string[]; now?: Date } = {}
): Promise<ImportResult> {
  const axes = [...new Set(rows.map((r) => r.axis))];
  for (const axis of axes) {
    await db
      .insertInto('KnightsQuestion')
      .values({
        key: axisKey(axis),
        kind: 'bool',
        prompt: axisPrompt(axis),
        options: JSON.stringify(YESNO_ANSWERS),
        minRank: 'Knight',
        votesToResolve: YESNO_CONSENSUS_VOTES,
        maxVotes: YESNO_MAX_VOTES,
        threshold: 0.5,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
  }

  const result: ImportResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    refused: 0,
    moderated: 0,
    retired: 0,
    revived: 0,
    axes: axes.length,
  };
  for (let at = 0; at < rows.length; at += batchSize) {
    const batch = rows.slice(at, at + batchSize);
    const written = await db
      .insertInto('KnightsQueueItem')
      .values(
        batch.map((r) => ({
          externalId: r.externalId,
          questionKey: axisKey(r.axis),
          imageId: r.imageId,
          source: YESNO_SOURCE,
          minRank: 'Knight',
          votesNeeded: YESNO_CONSENSUS_VOTES,
          priority: 2,
          expiresAt: null,
          audience: r.audience,
          prompt: r.prompt,
          yesEffect: r.yesEffect,
          noEffect: r.noEffect,
          meta: JSON.stringify(r.meta),
          createdAt: utcNow,
          updatedAt: utcNow,
        }))
      )
      .onConflict((oc) =>
        oc
          .column('externalId')
          .doUpdateSet((eb) => ({
            questionKey: eb.ref('excluded.questionKey'),
            imageId: eb.ref('excluded.imageId'),
            audience: eb.ref('excluded.audience'),
            prompt: eb.ref('excluded.prompt'),
            yesEffect: eb.ref('excluded.yesEffect'),
            noEffect: eb.ref('excluded.noEffect'),
            // Merged, so reopening a moderated item keeps its moderation record.
            meta: sql`COALESCE("KnightsQueueItem"."meta", '{}'::jsonb) || excluded."meta"`,
            updatedAt: eb.ref('excluded.updatedAt'),
            // A question the file withdrew and now lists again, with no answers, is open again.
            status: sql<string>`CASE WHEN ${retired} THEN 'Open' ELSE "KnightsQueueItem"."status" END`,
            reason: sql<
              string | null
            >`CASE WHEN ${retired} THEN NULL ELSE "KnightsQueueItem"."reason" END`,
            resolvedAt: sql<Date | null>`CASE WHEN ${retired} THEN NULL ELSE "KnightsQueueItem"."resolvedAt" END`,
          }))
          .where(
            sql<SqlBool>`"KnightsQueueItem"."voteCount" = 0 AND NOT ${moderatorRetired} AND (${retired} OR NOT ${isModeratedSql} AND
              ("KnightsQueueItem"."questionKey", "KnightsQueueItem"."imageId", "KnightsQueueItem"."audience", "KnightsQueueItem"."prompt",
               "KnightsQueueItem"."yesEffect", "KnightsQueueItem"."noEffect", "KnightsQueueItem"."meta")
              IS DISTINCT FROM
              (excluded."questionKey", excluded."imageId", excluded."audience", excluded."prompt",
               excluded."yesEffect", excluded."noEffect", excluded."meta")
            )`
          )
      )
      .returning(['externalId', sql<boolean>`(xmax = 0)`.as('inserted')])
      .execute();
    const inserted = written.filter((w) => w.inserted).length;
    result.inserted += inserted;
    result.updated += written.length - inserted;
    const skipped = batch.length - written.length;
    if (skipped > 0) {
      const wrote = new Set(written.map((w) => w.externalId));
      const left = batch.filter((r) => !wrote.has(r.externalId));
      const moderated = await countModerated(db, left);
      const refused = await countRefused(db, left);
      result.moderated += moderated;
      result.refused += refused;
      result.unchanged += skipped - moderated - refused;
      result.revived += await reviveReworded(db, left);
    }
  }
  await retireWithdrawn(db, retire, result, now, batchSize);
  return result;
}

/** The file never carries the moderation record a moderator's action merges into `meta`, so it is left out of the comparison. */
const sameMeta = (a: unknown, b: Record<string, string>) => {
  const { [MODERATION_META_KEY]: _moderation, ...stored } = (a ?? {}) as Record<string, unknown>;
  return JSON.stringify(Object.entries(stored).sort()) === JSON.stringify(Object.entries(b).sort());
};

async function countModerated(db: Kysely<DB>, skipped: YesNoRow[]): Promise<number> {
  const found = await db
    .selectFrom('KnightsQueueItem')
    .select('externalId')
    .where('voteCount', '=', 0)
    .where(sql<SqlBool>`(${isModeratedSql} OR ${moderatorRetired})`)
    .where(
      'externalId',
      'in',
      skipped.map((r) => r.externalId)
    )
    .execute();
  return found.length;
}

/**
 * A relisted question a moderator retired stays closed, but its latest reworded copy, if the import closed it when the
 * producer withdrew the question, comes back. A copy a moderator retired, one with answers, or any copy while another is open stays as it is.
 */
async function reviveReworded(db: Kysely<DB>, skipped: YesNoRow[]): Promise<number> {
  const originRow = sql<string | null>`"meta" ->> ${sql.lit(REWORD_OF_META_KEY)}`;
  const origins = await db
    .selectFrom('KnightsQueueItem')
    .select('externalId')
    .where('reason', '=', MODERATOR_RETIRED)
    .where(
      'externalId',
      'in',
      skipped.map((r) => r.externalId)
    )
    .execute();
  if (origins.length === 0) return 0;
  const copies = await db
    .selectFrom('KnightsQueueItem')
    .select(['id', 'externalId', 'status', 'reason', 'voteCount', originRow.as('origin')])
    .where(originRow, 'in', origins.map((o) => o.externalId) as string[])
    .execute();
  let revived = 0;
  for (const { externalId: origin } of origins) {
    const mine = copies.filter((c) => c.origin === origin);
    if (mine.some((c) => c.status === 'Open')) continue;
    const number = (c: { externalId: string | null }) =>
      Number(/:r(\d+)$/.exec(c.externalId ?? '')?.[1] ?? -1);
    const latest = mine
      .filter((c) => c.reason === 'retired' && c.voteCount === 0)
      .sort((a, b) => number(b) - number(a))[0];
    if (!latest) continue;
    const reopened = await db
      .updateTable('KnightsQueueItem')
      .set({ status: 'Open', reason: null, resolvedAt: null, updatedAt: utcNow })
      .where('id', '=', latest.id)
      .where('status', '=', 'Closed')
      .where('reason', '=', 'retired')
      .where('voteCount', '=', 0)
      .executeTakeFirst();
    revived += Number(reopened.numUpdatedRows);
  }
  return revived;
}

/** Rows the upsert left alone because they have answers: those that still differ from the file are refused, the rest unchanged. */
async function countRefused(db: Kysely<DB>, batch: YesNoRow[]): Promise<number> {
  const stored = await db
    .selectFrom('KnightsQueueItem')
    .select([
      'externalId',
      'questionKey',
      'imageId',
      'audience',
      'prompt',
      'yesEffect',
      'noEffect',
      'meta',
    ])
    .where('voteCount', '>', 0)
    .where(
      'externalId',
      'in',
      batch.map((r) => r.externalId)
    )
    .execute();
  const byId = new Map(stored.map((s) => [s.externalId, s]));
  return batch.filter((r) => {
    const s = byId.get(r.externalId);
    return (
      s &&
      !(
        s.questionKey === axisKey(r.axis) &&
        s.imageId === r.imageId &&
        s.audience === r.audience &&
        s.prompt === r.prompt &&
        s.yesEffect === r.yesEffect &&
        s.noEffect === r.noEffect &&
        sameMeta(s.meta, r.meta)
      )
    );
  }).length;
}

/** Closes open questions the producer withdrew, and their open reworded copies. Unanswered ones just close; answered ones drop their answers' gold like any no-outcome close. */
async function retireWithdrawn(
  db: Kysely<DB>,
  ids: string[],
  result: ImportResult,
  now: Date,
  batchSize: number
) {
  for (let at = 0; at < ids.length; at += batchSize) {
    const open = await db
      .selectFrom('KnightsQueueItem')
      .select('id')
      .where('status', '=', 'Open')
      .where('audience', 'is not', null)
      .where((eb) => {
        const withdrawn = ids.slice(at, at + batchSize);
        return eb.or([
          eb('externalId', 'in', withdrawn),
          sql<SqlBool>`"meta" ->> ${sql.lit(REWORD_OF_META_KEY)} IN (${sql.join(withdrawn)})`,
        ]);
      })
      .execute();
    for (const { id } of open) {
      if (await closeOpenYesNoItem(db, id, 'retired', now)) result.retired++;
    }
  }
}

export type ChunkSummary = {
  /** Records in the chunk, before any are skipped. */
  read: number;
  toImport: number;
  skipped: Skipped;
  /** Withdrawn ids in the chunk; only the import acts on them. */
  retire: number;
  /** Absent on a dry run, which writes nothing. */
  result?: ImportResult;
};

/** Parses one CSV chunk and, unless `dryRun`, imports it. A dry run also reads which images exist, so its counts match the import's, but writes nothing. */
export async function importYesNoChunk(
  db: Kysely<DB>,
  csv: string,
  { dryRun }: { dryRun: boolean }
): Promise<ChunkSummary> {
  const records = parseCsv(csv);
  const parsed = toYesNoRows(records);
  const { skipped, retire } = parsed;
  const rows = await dropMissingImages(db, parsed.rows, skipped);
  const summary: ChunkSummary = {
    read: records.length,
    toImport: rows.length,
    skipped,
    retire: retire.length,
  };
  if (!dryRun) summary.result = await importYesNo(db, rows, { retire });
  return summary;
}
