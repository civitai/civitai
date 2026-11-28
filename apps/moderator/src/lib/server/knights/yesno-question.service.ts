import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { utc } from '@civitai/db/kysely';
import { KNIGHTS_IMAGE_REPORT_REASON } from '@civitai/shared/new-order';
import {
  closeYesNoItemRow,
  mergeMeta,
  MODERATION_META_KEY,
  moderationMeta,
  MOD_TAG_REVIEW_SOURCE,
  MODERATOR_RETIRED,
  REPORT_REMOVED,
  REWORD_OF_META_KEY,
  YESNO_REPORTED,
  YESNO_QUESTION_MAX,
  type ModerationNote,
} from '@civitai/db/knights';
import { NOTE_MAX } from '../../knights/trials-limits';
import { dbWrite } from '../db';
import { countRows, FIRST_PAGE, pageWindow, type ListPage, type ListQuery } from './coreset.config';
import { unservableReason, type Outcome } from './coreset.service';

export const YESNO_QUESTION_STATUSES = ['open', 'reported', 'closed', 'all'] as const;
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
  /** Set on a question players reported past the threshold, which waits for a keep or remove. */
  reported: Reported | null;
};

export type Reported = {
  image: number;
  question: number;
  /** By player id, ascending; `username` is null for an account without one. */
  reporters: { id: number; username: string | null }[];
  /**
   * The image's open pull, if any. `causedHere`: this question's reports pulled it, so keeping this question returns the
   * image; otherwise another question's did. `filing` is 'pending' until Knights filed the main-app report (`reportId`),
   * or 'not-needed' when the main app no longer has the image.
   */
  pull: {
    causedHere: boolean;
    reportId: number | null;
    reportStatus: string | null;
    filing: string;
  } | null;
};

/** An image still pulled though the question that pulled it was removed or withdrawn: only Return gives it back. */
export type OrphanImagePull = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  itemId: number;
  prompt: string;
  questionKey: string;
  /** The pulling question's counted reports, by reason. */
  image: number;
  question: number;
  reportId: number | null;
  reportStatus: string | null;
  filing: string;
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
      .where('i.audience', '=', 'players')
      // A tag review item writes its answer back to the tag it names, so it cannot be retired or reworded here.
      .where('i.source', '<>', MOD_TAG_REVIEW_SOURCE);
    if (query.imageId !== undefined) q = q.where('i.imageId', '=', query.imageId);
    if (query.axis) q = q.where('i.questionKey', '=', query.axis);
    if (query.status === 'open') q = q.where('i.status', '=', 'Open');
    if (query.status === 'reported') q = q.where('i.status', '=', YESNO_REPORTED);
    // Closed is settled for good: a reported question still waits for a moderator.
    if (query.status === 'closed') q = q.where('i.status', 'not in', ['Open', YESNO_REPORTED]);
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
  const reported = await reportsOf(rows.filter((r) => r.status === YESNO_REPORTED));
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
      reported: reported.get(row.id) ?? null,
    };
  });
  return { items, total, page };
}

const reasonCounts = (reports: { reason: string }[]) => ({
  image: reports.filter((r) => r.reason === KNIGHTS_IMAGE_REPORT_REASON).length,
  question: reports.filter((r) => r.reason !== KNIGHTS_IMAGE_REPORT_REASON).length,
});

/** The counted, unresolved reports of each reported question, and its image's open pull with the main-app report's status. */
async function reportsOf(items: { id: number; imageId: number }[]): Promise<Map<number, Reported>> {
  if (items.length === 0) return new Map();
  const [reports, pulls] = await Promise.all([
    dbWrite
      .selectFrom('KnightsQuestionReport as qr')
      .leftJoin('User as u', 'u.id', 'qr.playerId')
      .select(['qr.itemId', 'qr.playerId', 'qr.reason', 'u.username'])
      .where(
        'qr.itemId',
        'in',
        items.map((i) => i.id)
      )
      .where('qr.counted', '=', true)
      .where('qr.resolvedAt', 'is', null)
      .orderBy('qr.playerId', 'asc')
      .execute(),
    dbWrite
      .selectFrom('KnightsImagePull as ip')
      .leftJoin('Report as r', 'r.id', 'ip.reportId')
      .select(['ip.imageId', 'ip.itemId', 'ip.reportId', 'ip.filing', 'r.status as reportStatus'])
      .where(
        'ip.imageId',
        'in',
        items.map((i) => i.imageId)
      )
      .where('ip.resolvedAt', 'is', null)
      .execute(),
  ]);
  const pullOf = new Map(pulls.map((p) => [p.imageId, p]));
  return new Map(
    items.map((item) => {
      const mine = reports.filter((r) => r.itemId === item.id);
      const pull = pullOf.get(item.imageId);
      return [
        item.id,
        {
          ...reasonCounts(mine),
          reporters: mine.map((r) => ({ id: r.playerId, username: r.username ?? null })),
          pull: pull
            ? {
                causedHere: pull.itemId === item.id,
                reportId: pull.reportId,
                reportStatus: pull.reportStatus ?? null,
                filing: pull.filing,
              }
            : null,
        },
      ];
    })
  );
}

/** Open image pulls whose question is no longer `Reported` (removed, or withdrawn by the import), oldest first. */
export async function getOrphanImagePulls(): Promise<OrphanImagePull[]> {
  const pulls = await dbWrite
    .selectFrom('KnightsImagePull as ip')
    .innerJoin('KnightsQueueItem as i', 'i.id', 'ip.itemId')
    .innerJoin('Image as img', 'img.id', 'ip.imageId')
    .leftJoin('Report as r', 'r.id', 'ip.reportId')
    .select([
      'ip.id',
      'ip.imageId',
      'ip.itemId',
      'ip.reportId',
      'ip.filing',
      'ip.createdAt',
      'r.status as reportStatus',
      'i.prompt',
      'i.questionKey',
      'img.url as imageKey',
      'img.name as imageName',
    ])
    .where('ip.resolvedAt', 'is', null)
    .where('i.status', '<>', YESNO_REPORTED)
    .orderBy('ip.id', 'asc')
    .execute();
  if (pulls.length === 0) return [];
  const reports = await dbWrite
    .selectFrom('KnightsQuestionReport')
    .select(['itemId', 'reason'])
    .where(
      'itemId',
      'in',
      pulls.map((p) => p.itemId)
    )
    .where('counted', '=', true)
    .execute();
  return pulls.map(({ prompt, reportStatus, ...pull }) => ({
    ...pull,
    prompt: prompt ?? '',
    reportStatus: reportStatus ?? null,
    ...reasonCounts(reports.filter((r) => r.itemId === pull.itemId)),
  }));
}

/** The image an open orphan pull holds; none when the pull is gone. */
export async function imagePullImageIds(id: number): Promise<number[]> {
  const row = await dbWrite
    .selectFrom('KnightsImagePull')
    .select('imageId')
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? [row.imageId] : [];
}

/**
 * Returns an image whose pulling question was removed or withdrawn: the pull is resolved, so the image's open questions and
 * Acolyte pairs are served again. A pull whose question still waits under Reported is that question's keep or remove.
 */
export async function returnImagePull(input: {
  id: number;
  by: number;
  now?: Date;
}): Promise<Outcome> {
  const now = input.now ?? new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const pull = await trx
      .selectFrom('KnightsImagePull as ip')
      .innerJoin('KnightsQueueItem as i', 'i.id', 'ip.itemId')
      .select(['ip.id', 'i.status'])
      .where('ip.id', '=', input.id)
      .where('ip.resolvedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!pull) return { ok: false, error: 'This image is no longer pulled. Reload the page.' };
    if (pull.status === YESNO_REPORTED)
      return { ok: false, error: 'Keep or remove the reported question that pulled this image.' };
    await trx
      .updateTable('KnightsImagePull')
      .set({ resolvedAt: utc(now), resolvedBy: input.by })
      .where('id', '=', pull.id)
      .execute();
    return { ok: true };
  });
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
    .where('source', '<>', MOD_TAG_REVIEW_SOURCE)
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

/** The image a yes/no question shows; none when the question is gone. */
export async function yesNoQuestionImageIds(id: number): Promise<number[]> {
  const row = await dbWrite
    .selectFrom('KnightsQueueItem')
    .select('imageId')
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? [row.imageId] : [];
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

/** Opens a question to players again, recording who did it; refused when its image can no longer be shown. */
async function reopen(
  trx: Trx,
  item: { id: number; imageId: number },
  action: 'restored' | 'kept',
  by: number,
  now: Date
): Promise<Outcome> {
  const problem = await unservableReason(item.imageId, trx);
  if (problem) return { ok: false, error: problem };
  await trx
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Open',
      reason: null,
      resolvedAt: null,
      updatedAt: utc(now),
      meta: mergeMeta(moderationMeta(action, by, '', now)),
    })
    .where('id', '=', item.id)
    .execute();
  return { ok: true };
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
    return reopen(trx, item, 'restored', input.by, now);
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
      const problem = await unservableReason(item.imageId, trx);
      if (problem) return { ok: false, error: problem };

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

const NOT_REPORTED = 'Only a reported question can be kept or removed. Reload the page.';

async function resolveReports(trx: Trx, itemId: number, by: number, now: Date) {
  await trx
    .updateTable('KnightsQuestionReport')
    .set({ resolvedAt: utc(now), resolvedBy: by })
    .where('itemId', '=', itemId)
    .where('resolvedAt', 'is', null)
    .execute();
}

/**
 * Keeps a question players reported: it is open again and served as before, its reports resolved; refused, as a restore is,
 * when its image can no longer be shown. When this question's reports pulled the image, the pull is resolved too, so the
 * image's open questions and Acolyte pairs are served again; a pull another question caused stays. The main-app report,
 * if one was filed, is its own moderators' to rule on.
 */
export async function keepReportedQuestion(input: {
  id: number;
  by: number;
  now?: Date;
}): Promise<Outcome> {
  const now = input.now ?? new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const item = await lockItem(trx, input.id);
    if (!item) return { ok: false, error: GONE };
    if (item.status !== YESNO_REPORTED) return { ok: false, error: NOT_REPORTED };
    const reopened = await reopen(trx, item, 'kept', input.by, now);
    if (!reopened.ok) return reopened;
    await resolveReports(trx, item.id, input.by, now);
    await trx
      .updateTable('KnightsImagePull')
      .set({ resolvedAt: utc(now), resolvedBy: input.by })
      .where('itemId', '=', item.id)
      .where('resolvedAt', 'is', null)
      .execute();
    return { ok: true };
  });
}

/**
 * Removes a question players reported: closed for good, as a retire closes one, with no label and no write-back; its
 * pending answers become inconclusive. An image pull it caused stays open, listed with the orphan pulls
 * (`getOrphanImagePulls`) until a moderator returns the image.
 */
export async function removeReportedQuestion(input: {
  id: number;
  by: number;
  now?: Date;
}): Promise<Outcome> {
  const now = input.now ?? new Date();
  return dbWrite.transaction().execute(async (trx) => {
    const item = await lockItem(trx, input.id);
    if (!item) return { ok: false, error: GONE };
    if (item.status !== YESNO_REPORTED) return { ok: false, error: NOT_REPORTED };
    await closeYesNoItemRow(
      trx,
      item.id,
      REPORT_REMOVED,
      now,
      moderationMeta('removed', input.by, '', now)
    );
    await resolveReports(trx, item.id, input.by, now);
    return { ok: true };
  });
}
