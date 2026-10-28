import { sql } from '@civitai/db/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { isRatingLevel } from '$lib/nsfw-levels';
import { dbRead, dbWrite } from '../db';
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
    ])
    .where('i.status', '=', 'Inquisitor')
    .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .orderBy('i.priority', 'asc')
    .orderBy('i.createdAt', 'asc')
    .orderBy('i.id', 'asc')
    .limit(INQUISITOR_QUEUE_LIMIT)
    .execute();
  if (items.length === 0) return [];

  const tallies = await dbRead
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

  return items.map(({ options, ...item }) => {
    const labels = new Map(parseOptions(options).map((option) => [option.value, option.label]));
    return {
      ...item,
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

export async function ruleOnInquisitorItem(
  itemId: number,
  level: number,
  moderatorId: number
): Promise<RulingOutcome> {
  if (!isRatingLevel(level)) return { ok: false, error: 'Pick a rating.' };

  const item = await dbWrite
    .selectFrom('KnightsQueueItem')
    .select(['imageId'])
    .where('id', '=', itemId)
    .where('status', '=', 'Inquisitor')
    .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .executeTakeFirst();
  if (!item) return { ok: false, error: GONE };

  await updateImageNsfwLevel({ id: item.imageId, nsfwLevel: level, userId: moderatorId });

  return dbWrite.transaction().execute(async (tx) => {
    const closed = await tx
      .updateTable('KnightsQueueItem')
      .set({
        status: 'Closed',
        resolvedValue: String(level),
        resolvedAt: new Date(),
        resolvedBy: moderatorId,
        appliedAt: new Date(),
        reason: 'moderator-ruled',
        updatedAt: new Date(),
      })
      .where('id', '=', itemId)
      .where('status', '=', 'Inquisitor')
      .returning('id')
      .executeTakeFirst();
    if (!closed) return { ok: false, error: GONE };

    await tx
      .updateTable('KnightsVote')
      .set({
        verdict: sql<string>`CASE WHEN "answer" = ${String(
          level
        )} THEN 'correct' ELSE 'failed' END`,
      })
      .where('itemId', '=', itemId)
      .where('verdict', '=', 'pending')
      .execute();
    return { ok: true };
  });
}
