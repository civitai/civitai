import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  canVote,
  FEED_STRETCH_SIZE,
  isRank,
  nextRank,
  stagesWorkedBy,
  STAGE_TTL_HOURS,
  type Rank,
} from './ranks';
import {
  decideChoice,
  isBlockedLevel,
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
  /**
   * Writes a settled answer back to the world, after the vote has committed. It must be safe to
   * repeat: when it throws the item stays settled and unapplied, and the expire job calls it again.
   */
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
  | 'unavailable'
  | 'not-eligible'
  | 'bad-answer'
  | 'already-voted';

export type CastVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'recorded' | 'resolved' | 'escalated' | 'inquisitor' };

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000);

const utc = (date: Date) => sql<Date>`${date.toISOString()}::timestamp`;

/** Items a player may be served and may vote on. The feed and `castVote` both start from here. */
function servableItems(db: Executor) {
  return db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .where('i.status', '=', 'Open')
    .where('i.isHiddenCheck', '=', false)
    .where('q.active', '=', true)
    .where('img.type', '=', 'image');
}

export async function getFeed(db: Executor, userId: number): Promise<Feed | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const stages = player ? stagesWorkedBy(player.rankType) : [];
  if (stages.length === 0) return null;

  const candidates = () =>
    servableItems(db)
      .where('i.minRank', 'in', stages)
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
      .orderBy(
        sql`CASE "i"."minRank" WHEN 'Paladin' THEN 3 WHEN 'Templar' THEN 2 ELSE 1 END`,
        'desc'
      )
      .orderBy('i.priority', 'asc')
      .orderBy('i.createdAt', 'asc')
      .orderBy('i.id', 'asc');

  const next = await candidates().select('q.key').limit(1).executeTakeFirst();
  if (!next) return null;

  const rows = await candidates()
    .where('q.key', '=', next.key)
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
    .limit(FEED_STRETCH_SIZE)
    .execute();

  const first = rows[0];
  if (!first) return null;

  return {
    question: {
      key: first.questionKey,
      kind: first.kind,
      prompt: first.prompt,
      options: first.options as QuestionOption[],
    },
    items: rows.map((r) => ({
      id: r.id,
      imageKey: r.imageKey,
      width: r.width,
      height: r.height,
    })),
  };
}

export type NewItem = {
  questionKey: string;
  imageId: number;
  source: string;
  minRank?: string;
  votesNeeded?: number;
  priority?: number;
  isHiddenCheck?: boolean;
  /** Omit for one stage from now; `null` for never. */
  expiresAt?: Date | null;
};

/** Adds an item to the queue. What it does not set itself comes from its question. */
export async function enqueueItem(db: Executor, input: NewItem, now: Date): Promise<number> {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['minRank', 'votesToResolve'])
    .where('key', '=', input.questionKey)
    .executeTakeFirstOrThrow();
  const expiresAt =
    input.expiresAt === undefined ? addHours(now, STAGE_TTL_HOURS) : input.expiresAt;

  const row = await db
    .insertInto('KnightsQueueItem')
    .values({
      questionKey: input.questionKey,
      imageId: input.imageId,
      source: input.source,
      minRank: input.minRank ?? question.minRank,
      votesNeeded: input.votesNeeded ?? question.votesToResolve,
      priority: input.priority ?? 2,
      isHiddenCheck: input.isHiddenCheck ?? false,
      expiresAt: expiresAt && utc(expiresAt),
      createdAt: utc(now),
      updatedAt: utc(now),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
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
      .set({
        minRank: next,
        expiresAt: utc(addHours(now, STAGE_TTL_HOURS)),
        updatedAt: utc(now),
      })
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
    .set({ status: 'Inquisitor', minRank: 'Inquisitor', expiresAt: null, updatedAt: utc(now) })
    .where('id', '=', itemId)
    .execute();
}

type Settled = { itemId: number; application: ConsensusApplication };

export async function castVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string },
  deps: QueueDeps
): Promise<CastVoteResult> {
  const now = deps.now();
  await ensureMonthPartition(db, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

  const { result, settled } = await db
    .transaction()
    .execute(async (trx): Promise<{ result: CastVoteResult; settled?: Settled }> => {
      const rejected = (reason: RejectReason) => ({
        result: { status: 'rejected', reason } as const,
      });

      // The item row lock serialises every vote on one item: it is what keeps one vote per player
      // (the partitioned ledger cannot carry that unique key) and lets only one vote resolve the item.
      const locked = await trx
        .selectFrom('KnightsQueueItem')
        .select(['id', 'status'])
        .where('id', '=', input.itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.status !== 'Open') return rejected('not-open');

      const item = await servableItems(trx)
        .where('i.id', '=', input.itemId)
        .select([
          'i.id',
          'i.questionKey',
          'i.imageId',
          'i.minRank',
          'i.votesNeeded',
          'q.options',
          'q.maxVotes',
          'q.threshold',
        ])
        .executeTakeFirst();
      if (!item) return rejected('unavailable');

      const player = await trx
        .selectFrom('NewOrderPlayer')
        .select(['rankType', 'exp'])
        .where('userId', '=', input.userId)
        .executeTakeFirst();
      if (!player) return rejected('no-player');
      if (!isRank(player.rankType) || !canVote(player.rankType, item.minRank)) {
        return rejected('not-eligible');
      }

      const options = item.options as QuestionOption[];
      if (!options.some((o) => o.value === input.answer)) return rejected('bad-answer');

      const already = await trx
        .selectFrom('KnightsVote')
        .select('playerId')
        .where('itemId', '=', item.id)
        .where('playerId', '=', input.userId)
        .executeTakeFirst();
      if (already) return rejected('already-voted');

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
          createdAt: utc(now),
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
        maxVotes: item.maxVotes,
        threshold: item.threshold,
      });
      if (decision.kind === 'pending') return { result: { status: 'recorded' } };
      if (decision.kind === 'split') return { result: { status: await escalate(trx, item, now) } };

      const writesBack = item.questionKey === NSFW_LEVEL_QUESTION;
      if (writesBack) {
        const image = await trx
          .selectFrom('Image')
          .select('nsfwLevel')
          .where('id', '=', item.imageId)
          .executeTakeFirst();
        const winner = Number(decision.value);
        if (isBlockedLevel(winner) || (image && isExcessiveDownRating(image.nsfwLevel, winner))) {
          await toInquisitor(trx, item.id, now);
          return { result: { status: 'inquisitor' } };
        }
      }

      await trx
        .updateTable('KnightsQueueItem')
        .set({
          status: 'Resolved',
          resolvedValue: decision.value,
          resolvedAt: utc(now),
          resolvedBy: input.userId,
          appliedAt: writesBack ? null : utc(now),
          updatedAt: utc(now),
        })
        .where('id', '=', item.id)
        .execute();
      await gradeVotes(trx, item.id, decision.value);

      return {
        result: { status: 'resolved' },
        settled: writesBack
          ? {
              itemId: item.id,
              application: {
                questionKey: item.questionKey,
                imageId: item.imageId,
                value: decision.value,
                actorId: input.userId,
              },
            }
          : undefined,
      };
    });

  if (settled) await applySettled(db, settled, deps);
  return result;
}

/** Writes one settled answer back and marks it applied. A failure leaves it for the next retry. */
async function applySettled(db: Kysely<DB>, settled: Settled, deps: QueueDeps): Promise<boolean> {
  try {
    await deps.applyConsensus(settled.application);
    await db
      .updateTable('KnightsQueueItem')
      .set({ appliedAt: utc(deps.now()) })
      .where('id', '=', settled.itemId)
      .where('appliedAt', 'is', null)
      .execute();
    return true;
  } catch (error) {
    console.error('knights: could not write a settled answer back, it will be retried', {
      itemId: settled.itemId,
      error,
    });
    return false;
  }
}

/** Retries every settled answer that has not been written back yet. */
export async function applyPendingResolutions(
  db: Kysely<DB>,
  deps: QueueDeps,
  { limit = 100 }: { limit?: number } = {}
): Promise<{ applied: number; failed: number }> {
  const pending = await db
    .selectFrom('KnightsQueueItem')
    .select(['id', 'questionKey', 'imageId', 'resolvedValue', 'resolvedBy'])
    .where('status', '=', 'Resolved')
    .where('appliedAt', 'is', null)
    .where('resolvedValue', 'is not', null)
    .where('resolvedBy', 'is not', null)
    .orderBy('resolvedAt', 'asc')
    .limit(limit)
    .execute();

  const counts = { applied: 0, failed: 0 };
  for (const row of pending) {
    const ok = await applySettled(
      db,
      {
        itemId: row.id,
        application: {
          questionKey: row.questionKey,
          imageId: row.imageId,
          value: row.resolvedValue as string,
          actorId: row.resolvedBy as number,
        },
      },
      deps
    );
    if (ok) counts.applied++;
    else counts.failed++;
  }
  return counts;
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
      .where('expiresAt', '<=', utc(now))
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
      .set({ status: 'Closed', updatedAt: utc(now) })
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

type Month = { year: number; month: number };

/** Creates one month's partition of the vote ledger if it is missing; safe to run concurrently. */
async function ensureMonthPartition(db: Kysely<DB>, { year, month }: Month): Promise<void> {
  const name = `KnightsVote_${year}_${pad(month)}`;
  const existing = await sql<{ found: boolean }>`
    SELECT to_regclass(${`"${name}"`}) IS NOT NULL AS found
  `.execute(db);
  if (existing.rows[0]?.found) return;

  const from = monthStart(year, month - 1);
  const to = monthStart(year, month);
  await db.transaction().execute(async (trx) => {
    // Two voters can find the same month missing; without the lock the loser fails on a duplicate relation.
    await sql`SELECT pg_advisory_xact_lock(hashtext('KnightsVote partitions'))`.execute(trx);
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "KnightsVote" ` +
          `FOR VALUES FROM ('${from.year}-${pad(from.month)}-01') TO ('${to.year}-${pad(
            to.month
          )}-01')`
      )
      .execute(trx);
  });
}

/** Creates the month partitions of the vote ledger from `now` through `monthsAhead` months out. */
export async function ensureVotePartitions(
  db: Kysely<DB>,
  { now, monthsAhead }: { now: Date; monthsAhead: number }
): Promise<void> {
  for (let i = 0; i <= monthsAhead; i++) {
    await ensureMonthPartition(db, monthStart(now.getUTCFullYear(), now.getUTCMonth() + i));
  }
}

export type { Rank };
