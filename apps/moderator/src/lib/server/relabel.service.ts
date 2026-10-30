import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from './moderator-db/types';
import { csamExcludedImageIds } from './relabel-csam-exclusion';
import { answersFromRow, answersToRow, type Answers } from '$lib/removal-label/questions';

// Blind relabel set for the removal-label pilot. Every read a LABELER can reach returns the item's
// opaque token and image id only: the stratum, the moderator's reason, the NSFW level, the other
// labeler's answer and the serial item id are what the blinding hides.

export type RelabelCandidate = { token: string; imageId: number };

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
    .select(['i.token', 'i.image_id as imageId'])
    .where('i.relabel', '=', true)
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
  if (skip.length) query = query.where('i.token', 'not in', skip);
  const rows = await query.execute();
  return rows.map((r) => ({ token: r.token, imageId: r.imageId }));
}

/** The labeler's own answer to one item, for editing it. Never anyone else's. */
export async function ownAnswer(
  db: Kysely<ModeratorDB>,
  labelerId: number,
  token: string
): Promise<(RelabelCandidate & { answers: Answers }) | null> {
  const row = await db
    .selectFrom('relabel_answer as a')
    .innerJoin('relabel_item as i', 'i.id', 'a.item_id')
    .select([
      'i.token',
      'i.image_id as imageId',
      'a.minor_present',
      'a.sexual_level',
      'a.violence',
      'a.school_setting',
    ])
    .where('i.token', '=', token)
    .where('a.labeler_id', '=', labelerId)
    .executeTakeFirst();
  const answers = row && answersFromRow(row);
  if (!row || !answers) return null;
  return { token: row.token, imageId: row.imageId, answers };
}

/**
 * Cloudflare keys for the images that may be shown now. Drops an image that is gone, is not a
 * still image, or that a CSAM report or block has touched since it was sampled.
 */
export async function servableImageKeys(
  mainDb: Kysely<MainDB>,
  imageIds: number[]
): Promise<Map<number, string>> {
  if (!imageIds.length) return new Map();
  const [rows, excluded] = await Promise.all([
    mainDb
      .selectFrom('Image')
      .select(['id', 'url'])
      .where('id', 'in', imageIds)
      .where('type', '=', 'image')
      .execute(),
    csamExcludedImageIds(imageIds).execute(mainDb),
  ]);
  const blocked = new Set(excluded.rows.map((r) => r.id));
  return new Map(rows.filter((r) => !blocked.has(r.id)).map((r) => [r.id, r.url]));
}

export async function lastAnsweredToken(
  db: Kysely<ModeratorDB>,
  labelerId: number
): Promise<string | null> {
  const row = await db
    .selectFrom('relabel_answer as a')
    .innerJoin('relabel_item as i', 'i.id', 'a.item_id')
    .select('i.token')
    .where('a.labeler_id', '=', labelerId)
    .orderBy('a.updated_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.token ?? null;
}

export type SaveResult = { ok: true } | { ok: false; reason: 'full' | 'missing' };

/**
 * Inserts or replaces this labeler's answer. `full` when two OTHER labelers already answered the
 * item: the database trigger refuses a third, so a race for the last slot cannot slip through.
 */
export async function saveAnswer(
  db: Kysely<ModeratorDB>,
  input: { labelerId: number; token: string; answers: Answers; durationMs: number | null }
): Promise<SaveResult> {
  const { labelerId, token, answers, durationMs } = input;
  const columns = answersToRow(answers);
  const item = await db
    .selectFrom('relabel_item')
    .select('id')
    .where('token', '=', token)
    .where('relabel', '=', true)
    .executeTakeFirst();
  if (!item) return { ok: false, reason: 'missing' };
  const itemId = String(item.id);
  try {
    const result = await db
      .insertInto('relabel_answer')
      .values({ item_id: itemId, labeler_id: labelerId, ...columns, duration_ms: durationMs })
      // duration_ms keeps the first answer's time on item: a quick correction must not make a
      // careful labeler read as a rubber-stamper.
      .onConflict((oc) =>
        oc.columns(['item_id', 'labeler_id']).doUpdateSet({ ...columns, updated_at: sql`now()` })
      )
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) return { ok: false, reason: 'missing' };
    return { ok: true };
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
      .where('i.relabel', '=', true)
      .executeTakeFirst(),
  ]);
  return {
    mine: Number(mine?.n ?? 0),
    items: Number(totals?.items ?? 0),
    complete: Number(totals?.complete ?? 0),
  };
}
