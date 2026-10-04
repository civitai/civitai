import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from './moderator-db/types';
import { HAND_OFF_TAGS, type TextLabel } from '$lib/automated-text/labels';
import type { HandOffSource } from '$lib/automated-text/hand-off';
import { reportEntityLabels, type ReportEntity } from '$lib/reports';

// Blind relabel of Clavata text hits. What a labeler can reach is the token, the text, the one tag it
// is judged against and the kind of content it came from. Confidence, stratum, wave, report and
// author ids and the other labeler's answer are what the blinding hides, until a hand-off.

export type TextRelabelItem = { token: string; tag: string; text: string; entityLabel: string };

const answerCount = sql`(SELECT count(*) FROM text_relabel_answer a WHERE a.item_id = i.id)`;

const entityLabel = (type: string) => reportEntityLabels[type as ReportEntity] ?? 'Unknown content';

/**
 * The next item for this labeler. Wave 1 is served before any of wave 2; within a wave the order is
 * a hash of item and labeler, so two labelers do not walk the set in the same sequence. Skips items
 * already holding two answers and items whose text has been purged.
 */
export async function nextItem(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  skip: string[] = []
): Promise<TextRelabelItem | null> {
  let query = db
    .selectFrom('text_relabel_item as i')
    .select(['i.token', 'i.tag', 'i.text_value', 'i.entity_type'])
    .where('i.text_value', 'is not', null)
    .where('i.purge_after', '>', sql<Date>`now()`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('text_relabel_answer as a')
            .select('a.id')
            .whereRef('a.item_id', '=', 'i.id')
            .where('a.labeler_id', '=', labelerId)
        )
      )
    )
    .where(sql<boolean>`${answerCount} < 2`)
    .orderBy('i.wave')
    .orderBy(sql`md5(${sql.ref('i.id')}::text || ':' || ${labelerId}::text)`)
    .limit(1);
  if (skip.length) query = query.where('i.token', 'not in', skip);
  const row = await query.executeTakeFirst();
  if (!row || row.text_value === null) return null;
  return {
    token: row.token,
    tag: row.tag,
    text: row.text_value,
    entityLabel: entityLabel(row.entity_type),
  };
}

/** The labeler's own answer to one item, for editing it. Never anyone else's. */
export async function ownAnswer(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  token: string
): Promise<(TextRelabelItem & { label: TextLabel; note: string | null }) | null> {
  const row = await db
    .selectFrom('text_relabel_answer as a')
    .innerJoin('text_relabel_item as i', 'i.id', 'a.item_id')
    .select(['i.token', 'i.tag', 'i.text_value', 'i.entity_type', 'a.label', 'a.note'])
    .where('i.token', '=', token)
    .where('a.labeler_id', '=', labelerId)
    .where('i.text_value', 'is not', null)
    .where('i.purge_after', '>', sql<Date>`now()`)
    .executeTakeFirst();
  if (!row || row.text_value === null) return null;
  return {
    token: row.token,
    tag: row.tag,
    text: row.text_value,
    entityLabel: entityLabel(row.entity_type),
    label: row.label as TextLabel,
    note: row.note,
  };
}

export async function lastAnsweredToken(
  db: Kysely<ModeratorDB>,
  labelerId: number
): Promise<string | null> {
  const row = await db
    .selectFrom('text_relabel_answer as a')
    .innerJoin('text_relabel_item as i', 'i.id', 'a.item_id')
    .select('i.token')
    .where('a.labeler_id', '=', labelerId)
    .orderBy('a.updated_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.token ?? null;
}

export type SaveResult = { ok: true; tag: string } | { ok: false; reason: 'full' | 'missing' };

/**
 * Inserts or replaces this labeler's answer. `full` when two OTHER labelers already answered: the
 * database trigger refuses a third. A purged item is `missing`, since its text can no longer be seen.
 */
export async function saveAnswer(
  db: Kysely<ModeratorDB>,
  input: {
    labelerId: number;
    token: string;
    label: TextLabel;
    note: string | null;
    durationMs: number | null;
  }
): Promise<SaveResult> {
  const { labelerId, token, label, note, durationMs } = input;
  const item = await db
    .selectFrom('text_relabel_item')
    .select(['id', 'tag'])
    .where('token', '=', token)
    .where('text_value', 'is not', null)
    .executeTakeFirst();
  if (!item) return { ok: false, reason: 'missing' };
  try {
    await db
      .insertInto('text_relabel_answer')
      .values({
        item_id: String(item.id),
        labeler_id: labelerId,
        label,
        note,
        duration_ms: durationMs,
      })
      // duration_ms keeps the first answer's time on item, as on the image relabel page.
      .onConflict((oc) =>
        oc.columns(['item_id', 'labeler_id']).doUpdateSet({ label, note, updated_at: sql`now()` })
      )
      .executeTakeFirst();
    return { ok: true, tag: item.tag };
  } catch (e) {
    const { code, constraint } = e as { code?: string; constraint?: string };
    // The trigger raises a bare check_violation; a named CHECK constraint failing is a real error.
    if (code === '23514' && !constraint) return { ok: false, reason: 'full' };
    if (code === '23503') return { ok: false, reason: 'missing' };
    throw e;
  }
}

export async function labelerProgress(
  db: Kysely<ModeratorDB>,
  labelerId: number
): Promise<{ mine: number; waveOne: number; waveOneDone: number }> {
  const [mine, totals] = await Promise.all([
    db
      .selectFrom('text_relabel_answer')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('labeler_id', '=', labelerId)
      .executeTakeFirst(),
    db
      .selectFrom('text_relabel_item as i')
      .select((eb) => [
        eb.fn.countAll<string>().as('items'),
        eb.fn
          .countAll<string>()
          .filterWhere(sql<boolean>`${answerCount} >= 1`)
          .as('done'),
      ])
      .where('i.wave', '=', 1)
      .executeTakeFirst(),
  ]);
  return {
    mine: Number(mine?.n ?? 0),
    waveOne: Number(totals?.items ?? 0),
    waveOneDone: Number(totals?.done ?? 0),
  };
}

export type HandOffItem = HandOffSource & { token: string; tag: string; answeredAt: Date };

/**
 * This labeler's clear violations on hand-off tags, newest first, so a case judged real stays one
 * click from the report and the author after the page has moved on, and after a reload.
 */
export async function ownHandOffs(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  limit = 20
): Promise<HandOffItem[]> {
  const rows = await db
    .selectFrom('text_relabel_answer as a')
    .innerJoin('text_relabel_item as i', 'i.id', 'a.item_id')
    .select([
      'i.token',
      'i.tag',
      'i.report_id',
      'i.entity_type',
      'i.entity_id',
      'i.author_id',
      'a.updated_at',
    ])
    .where('a.labeler_id', '=', labelerId)
    .where('a.label', '=', 'clear_violation')
    .where('i.tag', 'in', [...HAND_OFF_TAGS])
    .orderBy('a.updated_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    token: r.token,
    tag: r.tag,
    reportId: r.report_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    authorId: r.author_id,
    answeredAt: new Date(r.updated_at),
  }));
}
