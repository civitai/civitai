import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { servableImage } from '@civitai/db/knights';

export const JUDGMENTS_PAGE_SIZE = 20;

export type JudgmentStatus = 'pending' | 'correct' | 'wrong' | 'inconclusive';

export type Judgment = {
  itemId: number;
  /** Null when the image is no longer one the public feeds would show. */
  imageKey: string | null;
  prompt: string;
  answerLabel: string;
  status: JudgmentStatus;
  xp: number;
  gold: number;
  at: Date;
};

export const statusOf = (verdict: string): JudgmentStatus =>
  verdict === 'correct'
    ? 'correct'
    : verdict === 'failed'
    ? 'wrong'
    : verdict === 'inconclusive'
    ? 'inconclusive'
    : 'pending';

export async function listJudgments(
  db: Kysely<DB>,
  userId: number,
  { page, pageSize = JUDGMENTS_PAGE_SIZE }: { page: number; pageSize?: number }
): Promise<{ judgments: Judgment[]; hasMore: boolean }> {
  const rows = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('KnightsQuestion as q', 'q.key', 'v.questionKey')
    .leftJoin('KnightsQueueItem as it', 'it.id', 'v.itemId')
    .leftJoin('Image as img', 'img.id', 'v.imageId')
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select([
      'v.itemId',
      'v.answer',
      'v.verdict',
      'v.settledAt',
      'v.xp',
      'v.gold',
      'v.createdAt',
      'q.prompt',
      'it.prompt as itemPrompt',
      'q.options',
      'img.url as imageKey',
    ])
    .select((eb) => servableImage(eb).as('servable'))
    .where('v.playerId', '=', userId)
    .orderBy('v.createdAt', 'desc')
    .orderBy('v.itemId', 'desc')
    .limit(pageSize + 1)
    .offset((Math.max(1, page) - 1) * pageSize)
    .execute();

  return {
    hasMore: rows.length > pageSize,
    judgments: rows.slice(0, pageSize).map((r) => {
      const options = r.options as { value: string; label: string }[];
      return {
        itemId: r.itemId,
        imageKey: r.servable && r.imageKey ? r.imageKey : null,
        // A yes/no question carries its own words; the question row only holds the generic ones.
        prompt: r.itemPrompt ?? r.prompt,
        answerLabel: options.find((o) => o.value === r.answer)?.label ?? r.answer,
        status: r.settledAt ? statusOf(r.verdict) : 'pending',
        xp: r.xp,
        gold: r.gold ?? 0,
        at: r.createdAt,
      };
    }),
  };
}
