import { sql, utc } from '@civitai/db/kysely';
import { gradeKnightsVotes } from '@civitai/db/knights';
import { NsfwLevel } from '@civitai/shared';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { isRatingLevel } from '$lib/nsfw-levels';
import { dbWrite } from '../db';
import { updateImageNsfwLevel } from '../image-nsfw-level';

export const INQUISITOR_QUEUE_LIMIT = 100;

export type InquisitorVote = { answer: string; label: string; votes: number; weight: number };

export type InquisitorItem = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  imageType: string;
  prompt: string;
  reason: string | null;
  source: string;
  currentLevel: number;
  locked: boolean;
  hasBlockMarker: boolean;
  blockedFor: string | null;
  createdAt: Date;
  votes: InquisitorVote[];
};

type QuestionOption = { value: string; label: string };

const parseOptions = (value: unknown): QuestionOption[] =>
  Array.isArray(value)
    ? value.filter(
        (option): option is QuestionOption =>
          !!option && typeof option.value === 'string' && typeof option.label === 'string'
      )
    : [];

const hasBlockMarker = (image: { ingestion: string; blockedFor: string | null }) =>
  image.ingestion === 'Blocked' || image.blockedFor !== null;

export async function getInquisitorQueue(): Promise<InquisitorItem[]> {
  const items = await dbWrite
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .select([
      'i.id',
      'i.imageId',
      'i.reason',
      'i.source',
      'i.createdAt',
      'q.prompt',
      'q.options',
      'img.url as imageKey',
      'img.name as imageName',
      'img.type as imageType',
      'img.nsfwLevel as currentLevel',
      'img.nsfwLevelLocked as locked',
      'img.ingestion',
      'img.blockedFor',
    ])
    .where('i.status', '=', 'Inquisitor')
    .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .orderBy('i.priority', 'asc')
    .orderBy('i.createdAt', 'asc')
    .orderBy('i.id', 'asc')
    .limit(INQUISITOR_QUEUE_LIMIT)
    .execute();
  if (items.length === 0) return [];

  const tallies = await dbWrite
    .selectFrom('KnightsVote')
    .select([
      'itemId',
      'answer',
      sql<string>`count(*)`.as('votes'),
      sql<number>`sum("weight")`.as('weight'),
    ])
    .where(
      'itemId',
      'in',
      items.map((item) => item.id)
    )
    .groupBy(['itemId', 'answer'])
    .execute();

  return items.map(({ options, ingestion, ...item }) => {
    const labels = new Map(parseOptions(options).map((option) => [option.value, option.label]));
    return {
      ...item,
      hasBlockMarker: hasBlockMarker({ ingestion, blockedFor: item.blockedFor }),
      votes: tallies
        .filter((tally) => tally.itemId === item.id)
        .map((tally) => ({
          answer: tally.answer,
          label: labels.get(tally.answer) ?? tally.answer,
          votes: Number(tally.votes),
          weight: Number(tally.weight),
        }))
        .sort((a, b) => b.weight - a.weight || a.answer.localeCompare(b.answer)),
    };
  });
}

export type RulingOutcome = { ok: true } | { ok: false; error: string };

const GONE = 'This item has already been decided. Reload the page.';
const IN_PROGRESS = 'Another moderator is deciding this item right now. Reload the page.';
const TAKEN_OVER =
  'The rating was applied, but the item is now being decided by another moderator. Reload the page.';
const NOT_CLOSED =
  'The rating was applied but the item was not closed; reload and rule again with the same level.';

/** Must outlast the rating write, or a live ruling can be reclaimed. */
export const RULING_LEASE_MS = 10 * 60_000;

async function claim(itemId: number, moderatorId: number, now: Date) {
  return dbWrite
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Ruling',
      resolvedBy: moderatorId,
      nextAttemptAt: utc(new Date(now.getTime() + RULING_LEASE_MS)),
      updatedAt: utc(now),
    })
    .where('id', '=', itemId)
    .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'Inquisitor'),
        eb.and([eb('status', '=', 'Ruling'), eb('nextAttemptAt', '<=', utc(now))]),
      ])
    )
    .returning('imageId')
    .executeTakeFirst();
}

async function release(itemId: number, moderatorId: number, now: Date) {
  await dbWrite
    .updateTable('KnightsQueueItem')
    .set({ status: 'Inquisitor', resolvedBy: null, nextAttemptAt: null, updatedAt: utc(now) })
    .where('id', '=', itemId)
    .where('status', '=', 'Ruling')
    .where('resolvedBy', '=', moderatorId)
    .execute();
}

export async function ruleOnInquisitorItem(
  itemId: number,
  level: number,
  moderatorId: number,
  now: Date = new Date()
): Promise<RulingOutcome> {
  if (!isRatingLevel(level)) return { ok: false, error: 'Pick a rating.' };

  const claimed = await claim(itemId, moderatorId, now);
  if (!claimed) {
    const current = await dbWrite
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .executeTakeFirst();
    return { ok: false, error: current?.status === 'Ruling' ? IN_PROGRESS : GONE };
  }

  try {
    const image = await dbWrite
      .selectFrom('Image')
      .select(['ingestion', 'blockedFor'])
      .where('id', '=', claimed.imageId)
      .executeTakeFirst();
    if (image && hasBlockMarker(image) && level !== NsfwLevel.Blocked) {
      await release(itemId, moderatorId, now);
      return {
        ok: false,
        error:
          'This image is blocked, and rating it does not unblock it. Rule Blocked, or restore the image from the image queue first and rule again.',
      };
    }

    await updateImageNsfwLevel({ id: claimed.imageId, nsfwLevel: level, userId: moderatorId });
  } catch (error) {
    await release(itemId, moderatorId, now).catch(() => undefined);
    throw error;
  }

  try {
    const closed = await dbWrite.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('KnightsQueueItem')
        .set({
          status: 'Closed',
          resolvedValue: String(level),
          resolvedAt: utc(now),
          resolvedBy: moderatorId,
          appliedAt: utc(now),
          nextAttemptAt: null,
          reason: 'moderator-ruled',
          updatedAt: utc(now),
        })
        .where('id', '=', itemId)
        .where('status', '=', 'Ruling')
        .where('resolvedBy', '=', moderatorId)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;

      await gradeKnightsVotes(tx, itemId, String(level));
      return true;
    });
    if (closed) return { ok: true };
    const current = await dbWrite
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .executeTakeFirst();
    return { ok: false, error: current?.status === 'Ruling' ? TAKEN_OVER : GONE };
  } catch (error) {
    console.error('knights inquisitor: the rating was set but the item could not be closed', {
      itemId,
      error,
    });
    await release(itemId, moderatorId, now).catch(() => undefined);
    return { ok: false, error: NOT_CLOSED };
  }
}
