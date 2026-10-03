import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from './moderator-db/types';
import type { Answers } from '$lib/removal-label/questions';

// Blind relabel set for the removal-label pilot. Every read a LABELER can reach returns the item id
// and image id only: the stratum, the moderator's reason, the NSFW level and the other labeler's
// answer are what the blinding hides, so they never leave this file on the labeling path.

export type RelabelCandidate = { itemId: string; imageId: number };

const CANDIDATE_LIMIT = 20;

const answerCount = sql`(SELECT count(*) FROM relabel_answer a WHERE a.item_id = i.id)`;

/**
 * Items this labeler may answer next, in an order fixed per labeler (a hash of item and labeler),
 * so two labelers do not walk the set in the same sequence and neither sees removed items first.
 * Excludes items already holding two answers and items past their purge time, whose image is gone.
 */
export async function nextCandidates(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  skip: string[] = []
): Promise<RelabelCandidate[]> {
  let query = db
    .selectFrom('relabel_item as i')
    .select(['i.id as itemId', 'i.image_id as imageId'])
    .where((eb) =>
      eb.or([eb('i.purge_after', 'is', null), eb('i.purge_after', '>', sql<Date>`now()`)])
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('relabel_answer as a')
            .select('a.id')
            .whereRef('a.item_id', '=', 'i.id')
            .where('a.labeler_id', '=', labelerId)
        )
      )
    )
    .where(sql<boolean>`${answerCount} < 2`)
    .orderBy(sql`md5(${sql.ref('i.id')}::text || ':' || ${labelerId}::text)`)
    .limit(CANDIDATE_LIMIT);
  if (skip.length) query = query.where('i.id', 'not in', skip);
  const rows = await query.execute();
  return rows.map((r) => ({ itemId: String(r.itemId), imageId: r.imageId }));
}

/** The labeler's own answer to one item, for editing it. Never anyone else's. */
export async function ownAnswer(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  itemId: string
): Promise<(RelabelCandidate & { answers: Answers }) | null> {
  const row = await db
    .selectFrom('relabel_answer as a')
    .innerJoin('relabel_item as i', 'i.id', 'a.item_id')
    .select([
      'i.id as itemId',
      'i.image_id as imageId',
      'a.minor_present',
      'a.sexual_level',
      'a.violence',
      'a.school_setting',
    ])
    .where('a.item_id', '=', itemId)
    .where('a.labeler_id', '=', labelerId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    itemId: String(row.itemId),
    imageId: row.imageId,
    answers: {
      minorPresent: row.minor_present,
      sexualLevel: row.sexual_level,
      violence: row.violence,
      schoolSetting: row.school_setting,
    } as Answers,
  };
}

export async function lastAnsweredItemId(
  db: Kysely<ModeratorDB>,
  labelerId: number
): Promise<string | null> {
  const row = await db
    .selectFrom('relabel_answer')
    .select('item_id')
    .where('labeler_id', '=', labelerId)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? String(row.item_id) : null;
}

export type SaveResult = { ok: true } | { ok: false; reason: 'full' | 'missing' };

/**
 * Inserts or replaces this labeler's answer. `full` when two OTHER labelers already answered the
 * item: the database trigger refuses a third, so a race for the last slot cannot slip through.
 */
export async function saveAnswer(
  db: Kysely<ModeratorDB>,
  input: { labelerId: number; itemId: string; answers: Answers; durationMs: number | null }
): Promise<SaveResult> {
  const { labelerId, itemId, answers, durationMs } = input;
  const values = {
    minor_present: answers.minorPresent,
    sexual_level: answers.sexualLevel,
    violence: answers.violence,
    school_setting: answers.schoolSetting,
    duration_ms: durationMs,
  };
  try {
    const result = await db
      .insertInto('relabel_answer')
      .values({ item_id: itemId, labeler_id: labelerId, ...values })
      .onConflict((oc) =>
        oc.columns(['item_id', 'labeler_id']).doUpdateSet({ ...values, updated_at: sql`now()` })
      )
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) return { ok: false, reason: 'missing' };
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23514') return { ok: false, reason: 'full' };
    if (code === '23503') return { ok: false, reason: 'missing' };
    throw e;
  }
}

export async function labelerProgress(
  db: Kysely<ModeratorDB>,
  labelerId: number
): Promise<{ mine: number; items: number; complete: number }> {
  const [mine, totals] = await Promise.all([
    db
      .selectFrom('relabel_answer')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('labeler_id', '=', labelerId)
      .executeTakeFirst(),
    db
      .selectFrom('relabel_item as i')
      .select((eb) => [
        eb.fn.countAll<string>().as('items'),
        eb.fn
          .countAll<string>()
          .filterWhere(sql<boolean>`${answerCount} >= 2`)
          .as('complete'),
      ])
      .executeTakeFirst(),
  ]);
  return {
    mine: Number(mine?.n ?? 0),
    items: Number(totals?.items ?? 0),
    complete: Number(totals?.complete ?? 0),
  };
}
