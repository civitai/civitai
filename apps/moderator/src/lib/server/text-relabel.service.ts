import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from './moderator-db/types';
import {
  HAND_OFF_TAGS,
  looksLikeChatTranscript,
  maskChatSpeakers,
  needsHandOff,
  type TextLabel,
} from '$lib/automated-text/labels';
import type { HandOffItem } from '$lib/automated-text/hand-off';
import { reportEntityLabels, type ReportEntity } from '$lib/reports';

// Blind relabel: a labeler gets the token, text, tag and content kind. Confidence, stratum, wave,
// report/author ids and other labelers' answers stay hidden until a hand-off.

export type TextRelabelItem = {
  token: string;
  tag: string;
  text: string;
  /** Null when the entity was deleted before the snapshot: "deleted" would tell the labeler someone
   *  acted on it. */
  entityLabel: string | null;
};

const answerCount = sql`(SELECT count(*) FROM text_relabel_answer a WHERE a.item_id = i.id)`;

function toItem(row: {
  token: string;
  tag: string;
  text_value: string;
  entity_type: string;
}): TextRelabelItem {
  return {
    token: row.token,
    tag: row.tag,
    // On the text's shape too: a chat whose report row was already gone is stored as 'unknown'.
    text:
      row.entity_type === 'chat' || looksLikeChatTranscript(row.text_value)
        ? maskChatSpeakers(row.text_value)
        : row.text_value,
    entityLabel: reportEntityLabels[row.entity_type as ReportEntity] ?? null,
  };
}

/**
 * Wave 1 before wave 2; within a wave, ordered by a hash of item and labeler so two labelers do not
 * walk the set in the same sequence.
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
  return toItem({ ...row, text_value: row.text_value });
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
    ...toItem({ ...row, text_value: row.text_value }),
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
 * database trigger refuses a third. Purged or expired text is `missing`, since it can no longer be
 * shown.
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
    .where('purge_after', '>', sql<Date>`now()`)
    .executeTakeFirst();
  if (!item) return { ok: false, reason: 'missing' };
  const handedOffAt = needsHandOff(item.tag, label) ? sql<Date>`now()` : null;
  try {
    await db
      .insertInto('text_relabel_answer')
      .values({
        item_id: String(item.id),
        labeler_id: labelerId,
        label,
        note,
        duration_ms: durationMs,
        handed_off_at: handedOffAt,
      })
      // Both survive an edit: the first duration_ms, so a quick correction does not read as a
      // rubber-stamp; the first handed_off_at, so the eval can tell an edit made with the report in view.
      .onConflict((oc) =>
        oc.columns(['item_id', 'labeler_id']).doUpdateSet({
          label,
          note,
          updated_at: sql`now()`,
          handed_off_at: sql`coalesce(text_relabel_answer.handed_off_at, excluded.handed_off_at)`,
        })
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

/** This labeler's clear violations on hand-off tags, newest first, so a case stays reachable after
 *  the queue moves on. */
export async function ownHandOffs(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  opts: { limit?: number; token?: string } = {}
): Promise<HandOffItem[]> {
  let query = db
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
    .limit(opts.limit ?? 20);
  if (opts.token) query = query.where('i.token', '=', opts.token);
  const rows = await query.execute();
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
