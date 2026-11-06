import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  closeYesNoItemRow,
  mergeMeta,
  MODERATION_META_KEY,
  moderationMeta,
  MODERATOR_RETIRED,
  REWORD_OF_META_KEY,
  YESNO_QUESTION_MAX,
  type ModerationNote,
} from '@civitai/db/knights';
import { NOTE_MAX } from '../../knights/trials-limits';
import { dbWrite } from '../db';
import { countRows, FIRST_PAGE, pageWindow, type ListPage, type ListQuery } from './coreset.config';
import type { Outcome } from './coreset.service';

export const YESNO_QUESTION_STATUSES = ['open', 'closed', 'all'] as const;
export type YesNoQuestionStatus = (typeof YESNO_QUESTION_STATUSES)[number];

export type YesNoQuestionQuery = ListQuery & {
  axis?: string;
  status?: YesNoQuestionStatus;
  /** Matches the prompt, or also the image when `imageId` is given. */
  search?: { text: string; imageId?: number };
};

export type YesNoQuestionItem = {
  id: number;
  externalId: string | null;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  prompt: string;
  questionKey: string;
  status: string;
  reason: string | null;
  /** Closed by a moderator, so it can be restored. */
  retired: boolean;
  voteCount: number;
  moderation: ModerationNote | null;
  rewordOf: string | null;
  /** The open reworded copy that replaced this retired question, so it cannot be restored. */
  replacedBy: string | null;
  createdAt: Date;
};

const originOf = (item: { externalId: string | null; meta: unknown }) =>
  ((item.meta as Record<string, unknown> | null)?.[REWORD_OF_META_KEY] as string | undefined) ??
  item.externalId;

const GONE = 'This question is no longer available. Reload the page.';
const NEEDS_NOTE = 'Say why, so the next moderator knows.';
const NEEDS_PROMPT = 'Write the question players will be asked.';
const TOO_LONG = `Keep the question to ${YESNO_QUESTION_MAX} characters or fewer.`;
const NOTE_TOO_LONG = `Keep the note to ${NOTE_MAX} characters or fewer.`;
const RACED = 'Someone else reworded this question at the same moment. Reload and try again.';

type Trx = Transaction<DB>;

const UNIQUE_VIOLATION = '23505';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** Yes/no questions players are served, newest first. */
export async function getYesNoQuestionItems(
  query: YesNoQuestionQuery = FIRST_PAGE,
  pageSize = 50
): Promise<ListPage<YesNoQuestionItem>> {
  const filtered = () => {
    let q = dbWrite
      .selectFrom('KnightsQueueItem as i')
      .innerJoin('Image as img', 'img.id', 'i.imageId')
      .where('i.audience', '=', 'players');
    if (query.imageId !== undefined) q = q.where('i.imageId', '=', query.imageId);
    if (query.axis) q = q.where('i.questionKey', '=', query.axis);
    if (query.status === 'open') q = q.where('i.status', '=', 'Open');
    if (query.status === 'closed') q = q.where('i.status', '<>', 'Open');
    const { search } = query;
    if (search) {
      q = q.where((eb) => {
        const text = eb('i.prompt', 'ilike', `%${escapeLike(search.text)}%`);
        return search.imageId === undefined
          ? text
          : eb.or([text, eb('i.imageId', '=', search.imageId)]);
      });
    }
    return q;
  };
  const total = await countRows(filtered());
  const { page, offset, limit } = pageWindow(query.page, total, pageSize);
  const rows = await filtered()
    .select([
      'i.id',
      'i.externalId',
      'i.imageId',
      'i.prompt',
      'i.questionKey',
      'i.status',
      'i.reason',
      'i.voteCount',
      'i.meta',
      'i.createdAt',
      'img.url as imageKey',
      'img.name as imageName',
    ])
    .orderBy('i.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
  const copies = await openCopies(
    dbWrite,
    rows.filter((r) => r.status === 'Closed' && r.reason === MODERATOR_RETIRED).map(originOf)
  );
  const items = rows.map(({ meta, prompt, ...row }) => {
    const m = (meta ?? {}) as Record<string, unknown>;
    const origin = originOf({ externalId: row.externalId, meta });
    return {
      ...row,
      replacedBy: (row.status === 'Closed' && origin && copies.get(origin)) || null,
      prompt: prompt ?? '',
      retired: row.status === 'Closed' && row.reason === MODERATOR_RETIRED,
      moderation: (m[MODERATION_META_KEY] as ModerationNote | undefined) ?? null,
      rewordOf: (m[REWORD_OF_META_KEY] as string | undefined) ?? null,
    };
  });
  return { items, total, page };
}

/** Open reworded copies by origin producer id. Filters on audience, status and `meta->>'rewordOf'`, so no index beyond the open-items one is assumed. */
async function openCopies(db: Kysely<DB> | Trx, origins: (string | null)[]) {
  const ids = [...new Set(origins.filter((o): o is string => !!o))];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .selectFrom('KnightsQueueItem')
    .select(['externalId', sql<string>`"meta" ->> ${sql.lit(REWORD_OF_META_KEY)}`.as('origin')])
    .where('audience', '=', 'players')
    .where('status', '=', 'Open')
    .where(sql<string>`"meta" ->> ${sql.lit(REWORD_OF_META_KEY)}`, 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.origin, r.externalId ?? '']));
}

export async function getYesNoAxes(): Promise<{ key: string; prompt: string }[]> {
  return dbWrite
    .selectFrom('KnightsQuestion')
    .select(['key', 'prompt'])
    .where('kind', '=', 'bool')
    .where('key', 'like', 'knights.yesno.%')
    .orderBy('key', 'asc')
    .execute();
}

const lockColumns = [
  'id',
  'status',
  'reason',
  'voteCount',
  'externalId',
  'prompt',
  'meta',
  'questionKey',
  'imageId',
  'source',
  'minRank',
  'votesNeeded',
  'priority',
  'audience',
  'yesEffect',
  'noEffect',
] as const;

/** Locks the row before any check: a vote also takes it (after its player lock), so none can land between check and write. Never lock player rows here; that inverts the vote path's order. */
async function lockItem(trx: Trx, id: number) {
  return trx
    .selectFrom('KnightsQueueItem')
    .select(lockColumns)
    .where('id', '=', id)
    .where('audience', '=', 'players')
    .forUpdate()
    .executeTakeFirst();
}

function checkedNote(raw: string): { note: string } | { error: string } {
  const note = raw.trim();
  if (!note) return { error: NEEDS_NOTE };
  return note.length > NOTE_MAX ? { error: NOTE_TOO_LONG } : { note };
}

function checkedPrompt(raw: string): { prompt: string } | { error: string } {
  const prompt = raw.trim();
  if (!prompt) return { error: NEEDS_PROMPT };
  return prompt.length > YESNO_QUESTION_MAX ? { error: TOO_LONG } : { prompt };
}

export async function retireYesNoQuestion(input: {
  id: number;
  by: number;
  note: string;
  now?: Date;
}): Promise<Outcome> {
  const checked = checkedNote(input.note);
  if ('error' in checked) return { ok: false, error: checked.error };
  const now = input.now ?? new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const item = await lockItem(trx, input.id);
    if (!item) return { ok: false, error: GONE };
    if (item.status !== 'Open') {
      return { ok: false, error: 'Only an open question can be retired.' };
    }
    await closeYesNoItemRow(
      trx,
      item.id,
      MODERATOR_RETIRED,
      now,
      moderationMeta('retired', input.by, checked.note, now)
    );
    return { ok: true };
  });
}

/** Reopens a question a moderator retired, as long as nobody answered it. */
export async function unretireYesNoQuestion(input: {
  id: number;
  by: number;
  now?: Date;
}): Promise<Outcome> {
  const now = input.now ?? new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const item = await lockItem(trx, input.id);
    if (!item) return { ok: false, error: GONE };
    if (item.status !== 'Closed' || item.reason !== MODERATOR_RETIRED) {
      return { ok: false, error: 'Only a question a moderator retired can be restored.' };
    }
    if (item.voteCount > 0) {
      return { ok: false, error: 'Players have answered this question, so it stays retired.' };
    }
    const origin = originOf(item);
    const copy = origin && (await openCopies(trx, [origin])).get(origin);
    if (copy) return { ok: false, error: `Retire ${copy} first: it replaced this question.` };
    await trx
      .updateTable('KnightsQueueItem')
      .set({
        status: 'Open',
        reason: null,
        resolvedAt: null,
        updatedAt: sql<Date>`${now.toISOString()}::timestamp`,
        meta: mergeMeta(moderationMeta('restored', input.by, '', now)),
      })
      .where('id', '=', item.id)
      .execute();
    return { ok: true };
  });
}

/**
 * Retires an open question and opens a new one with the new words, `<origin externalId>:r<n>`. Always a new item, even with no
 * answers: label keys are per producer id, so an answer under a producer id must be an answer to the producer's wording.
 */
export async function rewordYesNoQuestion(input: {
  id: number;
  prompt: string;
  by: number;
  note: string;
  now?: Date;
}): Promise<Outcome> {
  const note = checkedNote(input.note);
  if ('error' in note) return { ok: false, error: note.error };
  const checked = checkedPrompt(input.prompt);
  if ('error' in checked) return { ok: false, error: checked.error };
  const { prompt } = checked;
  const now = input.now ?? new Date();
  const at = sql<Date>`${now.toISOString()}::timestamp`;

  try {
    return await dbWrite.transaction().execute(async (trx): Promise<Outcome> => {
      const item = await lockItem(trx, input.id);
      if (!item) return { ok: false, error: GONE };
      if (item.status !== 'Open') {
        return { ok: false, error: 'Only an open question can be reworded.' };
      }
      if (prompt === item.prompt) return { ok: false, error: 'That is already the question.' };

      const { [MODERATION_META_KEY]: _previous, ...inherited } = (item.meta ?? {}) as Record<
        string,
        unknown
      >;
      const origin =
        (inherited[REWORD_OF_META_KEY] as string | undefined) ?? item.externalId ?? String(item.id);
      const taken = await trx
        .selectFrom('KnightsQueueItem')
        .select('externalId')
        .where('externalId', 'like', `${escapeLike(origin)}:r%`)
        .execute();
      const suffix = /^:r(\d+)$/;
      const next =
        1 +
        Math.max(
          0,
          ...taken.map((t) =>
            Number(suffix.exec((t.externalId ?? '').slice(origin.length))?.[1] ?? 0)
          )
        );
      const externalId = `${origin}:r${next}`;

      await closeYesNoItemRow(
        trx,
        item.id,
        MODERATOR_RETIRED,
        now,
        moderationMeta('retired', input.by, `Reworded as ${externalId}: ${note.note}`, now)
      );
      await trx
        .insertInto('KnightsQueueItem')
        .values({
          externalId,
          questionKey: item.questionKey,
          imageId: item.imageId,
          source: item.source,
          minRank: item.minRank,
          votesNeeded: item.votesNeeded,
          priority: item.priority,
          expiresAt: null,
          audience: item.audience,
          prompt,
          yesEffect: item.yesEffect,
          noEffect: item.noEffect,
          meta: JSON.stringify({
            ...inherited,
            [REWORD_OF_META_KEY]: origin,
            ...moderationMeta('reworded', input.by, note.note, now),
          }),
          createdAt: at,
          updatedAt: at,
        })
        .execute();
      return { ok: true };
    });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { ok: false, error: RACED };
    throw error;
  }
}
