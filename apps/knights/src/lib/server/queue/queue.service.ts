import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  canVote,
  FEED_STRETCH_SIZE,
  isRank,
  nextRank,
  rankIndex,
  STAGE_TTL_HOURS,
  type Rank,
} from './ranks';
import {
  decideChoice,
  isExcessiveDownRating,
  levelForExp,
  voteWeight,
  type WeightedAnswer,
} from './resolution';

export const NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';

export type ConsensusApplication = {
  questionKey: string;
  imageId: number;
  value: string;
  actorId: number;
};

export type QueueDeps = {
  /** Runs inside the vote's transaction: if it throws, the vote that completed the item rolls back. */
  applyConsensus: (application: ConsensusApplication) => Promise<void>;
  now: () => Date;
};

type Executor = Kysely<DB> | Transaction<DB>;

export type QuestionOption = { value: string; label: string };

export type Feed = {
  question: { key: string; kind: string; prompt: string; options: QuestionOption[] };
  items: { id: number; imageKey: string; width: number | null; height: number | null }[];
};

export type RejectReason =
  | 'no-player'
  | 'not-open'
  | 'not-eligible'
  | 'bad-answer'
  | 'already-voted';

export type CastVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'recorded' | 'resolved' | 'escalated' | 'inquisitor' };

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000);

const ranksThatCanWork = (rank: string): string[] =>
  rankIndex(rank) < 1
    ? []
    : ['Knight', 'Templar', 'Paladin'].filter((r) => rankIndex(r) <= rankIndex(rank));

export async function getFeed(db: Executor, userId: number): Promise<Feed | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const eligibleRanks = player ? ranksThatCanWork(player.rankType) : [];
  if (eligibleRanks.length === 0) return null;

  const rows = await db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .select([
      'i.id',
      'q.key as questionKey',
      'q.kind',
      'q.prompt',
      'q.options',
      'img.url as imageKey',
      'img.width',
      'img.height',
    ])
    .where('i.status', '=', 'Open')
    .where('i.isHiddenCheck', '=', false)
    .where('q.active', '=', true)
    .where('img.type', '=', 'image')
    .where('i.minRank', 'in', eligibleRanks)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('KnightsVote as v')
            .select(sql<number>`1`.as('one'))
            .whereRef('v.itemId', '=', 'i.id')
            .where('v.playerId', '=', userId)
        )
      )
    )
    .orderBy(sql`CASE "i"."minRank" WHEN 'Paladin' THEN 3 WHEN 'Templar' THEN 2 ELSE 1 END`, 'desc')
    .orderBy('i.priority', 'asc')
    .orderBy('i.createdAt', 'asc')
    .orderBy('i.id', 'asc')
    .limit(FEED_STRETCH_SIZE * 5)
    .execute();

  const first = rows[0];
  if (!first) return null;
  const stretch = rows
    .filter((r) => r.questionKey === first.questionKey)
    .slice(0, FEED_STRETCH_SIZE);

  return {
    question: {
      key: first.questionKey,
      kind: first.kind,
      prompt: first.prompt,
      options: first.options as QuestionOption[],
    },
    items: stretch.map((r) => ({
      id: r.id,
      imageKey: r.imageKey,
      width: r.width,
      height: r.height,
    })),
  };
}

async function gradeVotes(trx: Executor, itemId: number, value: string) {
  await trx
    .updateTable('KnightsVote')
    .set({ verdict: sql<string>`CASE WHEN "answer" = ${value} THEN 'correct' ELSE 'failed' END` })
    .where('itemId', '=', itemId)
    .where('verdict', '=', 'pending')
    .execute();
}

async function escalate(
  trx: Executor,
  item: { id: number; minRank: string },
  now: Date
): Promise<'escalated' | 'inquisitor'> {
  const next = nextRank(item.minRank);
  if (next && next !== 'Inquisitor') {
    await trx
      .updateTable('KnightsQueueItem')
      .set({ minRank: next, expiresAt: addHours(now, STAGE_TTL_HOURS), updatedAt: now })
      .where('id', '=', item.id)
      .execute();
    return 'escalated';
  }
  await toInquisitor(trx, item.id, now);
  return 'inquisitor';
}

async function toInquisitor(trx: Executor, itemId: number, now: Date) {
  await trx
    .updateTable('KnightsQueueItem')
    .set({ status: 'Inquisitor', minRank: 'Inquisitor', expiresAt: null, updatedAt: now })
    .where('id', '=', itemId)
    .execute();
}

export async function castVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string },
  deps: QueueDeps
): Promise<CastVoteResult> {
  const now = deps.now();

  return db.transaction().execute(async (trx): Promise<CastVoteResult> => {
    // The item row lock serialises every vote on one item: it is what keeps one vote per player
    // (the partitioned ledger cannot carry that unique key) and lets only one vote resolve the item.
    const item = await trx
      .selectFrom('KnightsQueueItem')
      .selectAll()
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!item || item.status !== 'Open') return { status: 'rejected', reason: 'not-open' };

    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select(['rankType', 'exp'])
      .where('userId', '=', input.userId)
      .executeTakeFirst();
    if (!player) return { status: 'rejected', reason: 'no-player' };
    if (!isRank(player.rankType) || !canVote(player.rankType, item.minRank)) {
      return { status: 'rejected', reason: 'not-eligible' };
    }

    const question = await trx
      .selectFrom('KnightsQuestion')
      .selectAll()
      .where('key', '=', item.questionKey)
      .executeTakeFirstOrThrow();
    const options = question.options as QuestionOption[];
    if (!options.some((o) => o.value === input.answer)) {
      return { status: 'rejected', reason: 'bad-answer' };
    }

    const already = await trx
      .selectFrom('KnightsVote')
      .select('playerId')
      .where('itemId', '=', item.id)
      .where('playerId', '=', input.userId)
      .executeTakeFirst();
    if (already) return { status: 'rejected', reason: 'already-voted' };

    const smites = await trx
      .selectFrom('NewOrderSmite')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('targetPlayerId', '=', input.userId)
      .where('cleansedAt', 'is', null)
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('KnightsVote')
      .values({
        itemId: item.id,
        playerId: input.userId,
        createdAt: now,
        questionKey: item.questionKey,
        imageId: item.imageId,
        stage: item.minRank,
        answer: input.answer,
        weight: voteWeight({
          rank: player.rankType,
          level: levelForExp(player.exp),
          smites: Number(smites.n),
        }),
      })
      .execute();

    const stageVotes: WeightedAnswer[] = await trx
      .selectFrom('KnightsVote')
      .select(['answer', 'weight'])
      .where('itemId', '=', item.id)
      .where('stage', '=', item.minRank)
      .execute();

    const decision = decideChoice(stageVotes, {
      votesNeeded: item.votesNeeded,
      maxVotes: question.maxVotes,
      threshold: question.threshold,
    });
    if (decision.kind === 'pending') return { status: 'recorded' };
    if (decision.kind === 'split') return { status: await escalate(trx, item, now) };

    if (item.questionKey === NSFW_LEVEL_QUESTION) {
      const image = await trx
        .selectFrom('Image')
        .select('nsfwLevel')
        .where('id', '=', item.imageId)
        .executeTakeFirst();
      if (image && isExcessiveDownRating(image.nsfwLevel, Number(decision.value))) {
        await toInquisitor(trx, item.id, now);
        return { status: 'inquisitor' };
      }
      await deps.applyConsensus({
        questionKey: item.questionKey,
        imageId: item.imageId,
        value: decision.value,
        actorId: input.userId,
      });
    }

    await trx
      .updateTable('KnightsQueueItem')
      .set({ status: 'Resolved', resolvedValue: decision.value, resolvedAt: now, updatedAt: now })
      .where('id', '=', item.id)
      .execute();
    await gradeVotes(trx, item.id, decision.value);
    return { status: 'resolved' };
  });
}

/** Escalates every open item past its expiry one rank. Nothing is deleted. */
export async function escalateExpired(
  db: Kysely<DB>,
  { now, limit = 200 }: { now: Date; limit?: number }
): Promise<{ escalated: number; toInquisitor: number }> {
  return db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('KnightsQueueItem')
      .select(['id', 'minRank'])
      .where('status', '=', 'Open')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    const counts = { escalated: 0, toInquisitor: 0 };
    for (const item of due) {
      const outcome = await escalate(trx, item, now);
      if (outcome === 'escalated') counts.escalated++;
      else counts.toInquisitor++;
    }
    return counts;
  });
}

/** Closes an item no one could decide: its pending votes are inconclusive, never failed. */
export async function closeWithoutOutcome(db: Kysely<DB>, itemId: number, now: Date) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('KnightsQueueItem')
      .set({ status: 'Closed', updatedAt: now })
      .where('id', '=', itemId)
      .execute();
    await trx
      .updateTable('KnightsVote')
      .set({ verdict: 'inconclusive' })
      .where('itemId', '=', itemId)
      .where('verdict', '=', 'pending')
      .execute();
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

/** Creates the month partitions of the vote ledger from `now` through `monthsAhead` months out. */
export async function ensureVotePartitions(
  db: Kysely<DB>,
  { now, monthsAhead }: { now: Date; monthsAhead: number }
): Promise<void> {
  for (let i = 0; i <= monthsAhead; i++) {
    const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() + i);
    const to = monthStart(now.getUTCFullYear(), now.getUTCMonth() + i + 1);
    const name = `KnightsVote_${from.year}_${pad(from.month)}`;
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "KnightsVote" ` +
          `FOR VALUES FROM ('${from.year}-${pad(from.month)}-01') TO ('${to.year}-${pad(
            to.month
          )}-01')`
      )
      .execute(db);
  }
}

export type { Rank };
