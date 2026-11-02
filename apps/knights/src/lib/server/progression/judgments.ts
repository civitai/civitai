import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { servableImage } from '@civitai/db/knights';

export const JUDGMENTS_PAGE_SIZE = 20;

export type JudgmentStatus = 'pending' | 'correct' | 'wrong' | 'inconclusive' | 'forfeited';

export const JUDGMENT_FILTERS = [
  'all',
  'correct',
  'wrong',
  'pending',
  'inconclusive',
  'forfeited',
] as const;
export type JudgmentFilter = (typeof JUDGMENT_FILTERS)[number];

export const parseJudgmentFilter = (raw: string | null): JudgmentFilter =>
  JUDGMENT_FILTERS.find((f) => f === raw) ?? 'all';

export type Judgment = {
  /** A vote's item id, or a Trial's reference id; unique only together with `kind`. */
  itemId: number;
  kind: 'vote' | 'trial';
  imageId: number;
  /** Null when the image is no longer one the public feeds would show. */
  imageKey: string | null;
  prompt: string;
  answerLabel: string;
  /** The settled answer, only for a vote that turned out wrong. */
  verdictLabel: string | null;
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

/**
 * A vote cast before the player's last career reset (`startAt`) never pays: the settlement in `payOutVotes` drops its
 * gold and bulk XP whatever the verdict. Wrong and set-aside votes keep their own status.
 */
export const forfeitedByReset = (castAt: Date, startAt: Date | null, status: JudgmentStatus) =>
  startAt !== null && castAt < startAt && (status === 'pending' || status === 'correct');

/** The status filter as SQL over the columns `statusOf` and `forfeitedByReset` read; keep the three in step. */
function filterClause(filter: Exclude<JudgmentFilter, 'all'>) {
  const unsettled = sql<SqlBool>`(j."settledAt" IS NULL OR j."verdict" NOT IN ('correct', 'failed', 'inconclusive'))`;
  const isCorrect = sql<SqlBool>`(j."settledAt" IS NOT NULL AND j."verdict" = 'correct')`;
  const forfeited = sql<SqlBool>`(j."startAt" IS NOT NULL AND j."createdAt" < j."startAt" AND (${unsettled} OR ${isCorrect}))`;
  switch (filter) {
    case 'forfeited':
      return forfeited;
    case 'pending':
      return sql<SqlBool>`(${unsettled} AND NOT ${forfeited})`;
    case 'correct':
      return sql<SqlBool>`(${isCorrect} AND NOT ${forfeited})`;
    case 'wrong':
      return sql<SqlBool>`(j."settledAt" IS NOT NULL AND j."verdict" = 'failed')`;
    case 'inconclusive':
      return sql<SqlBool>`(j."settledAt" IS NOT NULL AND j."verdict" = 'inconclusive')`;
  }
}

export async function listJudgments(
  db: Kysely<DB>,
  userId: number,
  {
    page,
    pageSize = JUDGMENTS_PAGE_SIZE,
    filter = 'all',
  }: { page: number; pageSize?: number; filter?: JudgmentFilter }
): Promise<{ judgments: Judgment[]; hasMore: boolean }> {
  // Hidden checks have no queue item, so they carry no settled answer and read like any other vote.
  const votes = db
    .selectFrom('KnightsVote as v')
    .innerJoin('KnightsQuestion as q', 'q.key', 'v.questionKey')
    .leftJoin('KnightsQueueItem as it', 'it.id', 'v.itemId')
    .leftJoin('Image as img', 'img.id', 'v.imageId')
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .leftJoin('NewOrderPlayer as pl', 'pl.userId', 'v.playerId')
    .select((eb) => [
      sql<string>`'vote'`.as('kind'),
      'v.itemId',
      'v.imageId',
      'v.answer',
      'v.verdict',
      'v.settledAt',
      'v.xp',
      sql<number>`COALESCE(v.gold, 0)`.as('gold'),
      'v.createdAt',
      'pl.startAt',
      'q.prompt',
      'it.prompt as itemPrompt',
      'q.options',
      sql<
        string | null
      >`CASE WHEN it.status IN ('Resolved', 'Consensus') THEN it."resolvedValue" END`.as(
        'resolved'
      ),
      'img.url as imageKey',
      servableImage(eb).as('servable'),
    ])
    .where('v.playerId', '=', userId);

  // A Trial answer is graded when it is given and pays nothing, so it never waits or forfeits.
  const trials = db
    .selectFrom('KnightsTrialAnswer as a')
    .innerJoin('KnightsReferenceImage as r', 'r.id', 'a.referenceId')
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .leftJoin('Image as img', 'img.id', 'r.imageId')
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select((eb) => [
      sql<string>`'trial'`.as('kind'),
      'a.referenceId as itemId',
      'r.imageId',
      'a.answer',
      sql<string>`CASE WHEN a.correct THEN 'correct' ELSE 'failed' END`.as('verdict'),
      'a.createdAt as settledAt',
      sql<number>`0`.as('xp'),
      sql<number>`0`.as('gold'),
      'a.createdAt',
      sql<Date | null>`NULL`.as('startAt'),
      'q.prompt',
      sql<string | null>`NULL`.as('itemPrompt'),
      'q.options',
      'r.answer as resolved',
      'img.url as imageKey',
      servableImage(eb).as('servable'),
    ])
    .where('a.playerId', '=', userId);

  let query = db.selectFrom(votes.unionAll(trials).as('j')).selectAll();
  if (filter !== 'all') query = query.where(filterClause(filter));

  const rows = await query
    .orderBy('j.createdAt', 'desc')
    .orderBy('j.kind', 'desc')
    .orderBy('j.itemId', 'desc')
    .limit(pageSize + 1)
    .offset((Math.max(1, page) - 1) * pageSize)
    .execute();

  return {
    hasMore: rows.length > pageSize,
    judgments: rows.slice(0, pageSize).map((r) => {
      const options = r.options as { value: string; label: string }[];
      const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;
      const status = r.settledAt ? statusOf(r.verdict) : 'pending';
      const forfeited = forfeitedByReset(r.createdAt, r.startAt, status);
      return {
        itemId: r.itemId,
        kind: r.kind as Judgment['kind'],
        imageId: r.imageId,
        imageKey: r.servable && r.imageKey ? r.imageKey : null,
        // A yes/no question carries its own words; the question row only holds the generic ones.
        prompt: r.itemPrompt ?? r.prompt,
        answerLabel: labelOf(r.answer),
        verdictLabel: status === 'wrong' && r.resolved ? labelOf(r.resolved) : null,
        status: forfeited ? 'forfeited' : status,
        xp: r.xp,
        gold: forfeited ? 0 : r.gold,
        at: r.createdAt,
      };
    }),
  };
}
