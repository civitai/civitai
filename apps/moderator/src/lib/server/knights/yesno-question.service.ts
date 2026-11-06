import { sql, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { closeYesNoItemRow, MODERATOR_RETIRED, YESNO_QUESTION_MAX } from '@civitai/db/knights';
import { dbWrite } from '../db';
import { FIRST_PAGE, pageWindow, type ListPage, type ListQuery } from './coreset.config';
import type { Outcome } from './coreset.service';

export const YESNO_QUESTION_STATUSES = ['open', 'closed', 'all'] as const;
export type YesNoQuestionStatus = (typeof YESNO_QUESTION_STATUSES)[number];
export const NOTE_MAX = 500;

export type YesNoQuestionQuery = ListQuery & {
  axis?: string;
  status?: YesNoQuestionStatus;
  /** Matches inside the prompt, case-insensitively. */
  text?: string;
};

export type ModerationNote = { action: string; by: number; note: string; at: string };

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
  voteCount: number;
  moderation: ModerationNote | null;
  rewordOf: string | null;
  createdAt: Date;
};

const GONE = 'This question is no longer available. Reload the page.';
const NEEDS_NOTE = 'Say why, so the next moderator knows.';
const NEEDS_PROMPT = 'Write the question players will be asked.';
const TOO_LONG = `Keep the question to ${YESNO_QUESTION_MAX} characters or fewer.`;
const NOTE_TOO_LONG = `Keep the note to ${NOTE_MAX} characters or fewer.`;

type Trx = Transaction<DB>;

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** Yes/no questions players are served, newest first. Closed means any item no longer open. */
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
    if (query.text) q = q.where('i.prompt', 'ilike', likePattern(query.text));
    return q;
  };
  const counted = await filtered()
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  const total = Number(counted.count);
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
  const items = rows.map(({ meta, prompt, ...row }) => {
    const m = (meta ?? {}) as { moderation?: ModerationNote; rewordOf?: string };
    return {
      ...row,
      prompt: prompt ?? '',
      moderation: m.moderation ?? null,
      rewordOf: m.rewordOf ?? null,
    };
  });
  return { items, total, page };
}

/** Axes player yes/no questions fall under, for the filter. */
export async function getYesNoAxes(): Promise<{ key: string; prompt: string }[]> {
  return dbWrite
    .selectFrom('KnightsQuestion')
    .select(['key', 'prompt'])
    .where('kind', '=', 'bool')
    .where('key', 'like', 'knights.yesno.%')
    .orderBy('key', 'asc')
    .execute();
}

type Locked = {
  id: number;
  status: string;
  reason: string | null;
  voteCount: number;
  externalId: string | null;
  prompt: string | null;
  meta: unknown;
};

/**
 * The row lock comes first, so a vote cannot land between the checks and the write; the vote path takes its own player lock,
 * then this row. Only the item row and its votes are touched here, never player rows.
 */
async function lockItem(trx: Trx, id: number): Promise<Locked | undefined> {
  return trx
    .selectFrom('KnightsQueueItem')
    .select(['id', 'status', 'reason', 'voteCount', 'externalId', 'prompt', 'meta'])
    .where('id', '=', id)
    .where('audience', '=', 'players')
    .forUpdate()
    .executeTakeFirst();
}

const moderation = (action: string, by: number, note: string, now: Date): ModerationNote => ({
  action,
  by,
  note,
  at: now.toISOString(),
});

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

const mergeMeta = (patch: Record<string, unknown>) =>
  sql`COALESCE("meta", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;

/**
 * Closes an open question as `moderator-retired`. Its pending votes become inconclusive and the Knights tick pays them out like
 * any other close: voters lose only the pending gold.
 */
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
    await closeYesNoItemRow(trx, item.id, MODERATOR_RETIRED, now, {
      moderation: moderation('retired', input.by, checked.note, now),
    });
    return { ok: true };
  });
}

/** Reopens a question a moderator retired, as long as nobody answered it. */
export async function unretireYesNoQuestion(input: {
  id: number;
  by: number;
  note?: string;
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
    await trx
      .updateTable('KnightsQueueItem')
      .set({
        status: 'Open',
        reason: null,
        resolvedAt: null,
        updatedAt: sql<Date>`${now.toISOString()}::timestamp`,
        meta: mergeMeta({
          moderation: moderation('restored', input.by, input.note?.trim() ?? '', now),
        }),
      })
      .where('id', '=', item.id)
      .execute();
    return { ok: true };
  });
}

/**
 * Rewrites an open question. With no answers yet the prompt changes in place. Otherwise answers stay tied to the words they
 * answered: the old item is retired and a new open item carries the new words, as `<externalId>:r<n>`.
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

  return dbWrite.transaction().execute(async (trx): Promise<Outcome> => {
    const item = await lockItem(trx, input.id);
    if (!item) return { ok: false, error: GONE };
    if (item.status !== 'Open') {
      return { ok: false, error: 'Only an open question can be reworded.' };
    }
    if (prompt === item.prompt) return { ok: false, error: 'That is already the question.' };

    if (item.voteCount === 0) {
      await trx
        .updateTable('KnightsQueueItem')
        .set({
          prompt,
          updatedAt: at,
          meta: mergeMeta({ moderation: moderation('reworded', input.by, note.note, now) }),
        })
        .where('id', '=', item.id)
        .execute();
      return { ok: true };
    }

    const base = item.externalId ?? String(item.id);
    const taken = await trx
      .selectFrom('KnightsQueueItem')
      .select('externalId')
      .where('externalId', 'like', `${base.replace(/[\\%_]/g, '\\$&')}:r%`)
      .execute();
    const used = taken.map((t) => /^:r(\d+)$/.exec((t.externalId ?? '').slice(base.length))?.[1]);
    const next = Math.max(0, ...used.map((n) => Number(n ?? 0))) + 1;
    const externalId = `${base}:r${next}`;

    const original = await trx
      .selectFrom('KnightsQueueItem')
      .select([
        'questionKey',
        'imageId',
        'source',
        'minRank',
        'votesNeeded',
        'priority',
        'audience',
      ])
      .select(['yesEffect', 'noEffect', 'meta'])
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    const { moderation: _previous, ...inherited } = (original.meta ?? {}) as Record<
      string,
      unknown
    >;

    await closeYesNoItemRow(trx, item.id, MODERATOR_RETIRED, now, {
      moderation: moderation('retired', input.by, `Reworded as ${externalId}: ${note.note}`, now),
    });
    await trx
      .insertInto('KnightsQueueItem')
      .values({
        externalId,
        questionKey: original.questionKey,
        imageId: original.imageId,
        source: original.source,
        minRank: original.minRank,
        votesNeeded: original.votesNeeded,
        priority: original.priority,
        expiresAt: null,
        audience: original.audience,
        prompt,
        yesEffect: original.yesEffect,
        noEffect: original.noEffect,
        meta: JSON.stringify({
          ...inherited,
          rewordOf: base,
          moderation: moderation('reworded', input.by, note.note, now),
        }),
        createdAt: at,
        updatedAt: at,
      })
      .execute();
    return { ok: true };
  });
}
