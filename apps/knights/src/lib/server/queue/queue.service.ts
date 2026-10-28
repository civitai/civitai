import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  canVote,
  FEED_STRETCH_SIZE,
  isRank,
  isStageRank,
  nextRank,
  stagesWorkedBy,
  STAGE_TTL_HOURS,
  type Rank,
} from './ranks';
import {
  BLOCKED_LEVEL,
  decideChoice,
  decideWriteback,
  isBlockedLevel,
  isExcessiveDownRating,
  levelForExp,
  voteWeight,
  type ImageState,
  type WeightedAnswer,
  type WritebackDecision,
} from './resolution';

export const NSFW_LEVEL_QUESTION = 'knights.image.nsfwLevel';

export type ConsensusApplication = {
  questionKey: string;
  imageId: number;
  value: string;
  actorId: number;
};

/** What the world said to a settled answer. A skip is final; only a throw is worth retrying. */
export type ApplyOutcome =
  | { outcome: 'applied' }
  | { outcome: 'skipped'; reason: 'missing' | 'blocked' | 'locked'; currentLevel: number | null };

export type QueueDeps = {
  /**
   * Writes a settled answer back to the world, after the vote has committed. A throw is a transient
   * failure: the item stays settled and unapplied, and the expire job calls it again with backoff.
   */
  applyConsensus: (application: ConsensusApplication) => Promise<ApplyOutcome>;
  now: () => Date;
};

/** A write-back that keeps failing is handed to the Inquisitors after this many tries. */
export const MAX_APPLY_ATTEMPTS = 8;
const LEASE_MINUTES = 2;
const MAX_BACKOFF_MINUTES = 360;
/** Minutes to wait after the nth failed try: 5, 10, 20, ... up to six hours. */
export const backoffMinutes = (attempts: number) =>
  Math.min(5 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MINUTES);

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
  | 'already-voted'
  | 'no-weight';

export type CastVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'recorded' | 'resolved' | 'escalated' | 'inquisitor' };

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000);
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const utc = (date: Date) => sql<Date>`${date.toISOString()}::timestamp`;

/** Items a player may be served and may vote on. The feed and `castVote` both start from here. */
function servableItems(db: Executor) {
  return db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('i.status', '=', 'Open')
    .where('i.isHiddenCheck', '=', false)
    .where('q.active', '=', true)
    .where('img.type', '=', 'image')
    .where('img.nsfwLevel', 'not in', [0, BLOCKED_LEVEL])
    .where('img.ingestion', '!=', 'Blocked')
    .where('img.blockedFor', 'is', null)
    .where('p.publishedAt', 'is not', null)
    .where('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`);
}

export async function getFeed(
  db: Executor,
  userId: number,
  { limit = FEED_STRETCH_SIZE }: { limit?: number } = {}
): Promise<Feed | null> {
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
    .limit(limit)
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
  const minRank = input.minRank ?? question.minRank;
  if (!isStageRank(minRank)) throw new Error(`"${minRank}" is not a rank an item can wait at`);
  const expiresAt =
    input.expiresAt === undefined ? addHours(now, STAGE_TTL_HOURS) : input.expiresAt;

  const row = await db
    .insertInto('KnightsQueueItem')
    .values({
      questionKey: input.questionKey,
      imageId: input.imageId,
      source: input.source,
      minRank,
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

/** Replaces the verdicts of every vote on an item, settled ones included. */
async function regradeVotes(
  trx: Executor,
  itemId: number,
  verdict: 'pending' | 'inconclusive' | { correctAnswer: string }
) {
  await trx
    .updateTable('KnightsVote')
    .set({
      verdict:
        typeof verdict === 'string'
          ? verdict
          : sql<string>`CASE WHEN "answer" = ${verdict.correctAnswer} THEN 'correct' ELSE 'failed' END`,
    })
    .where('itemId', '=', itemId)
    .execute();
}

async function toInquisitor(trx: Executor, itemId: number, now: Date) {
  await trx
    .updateTable('KnightsQueueItem')
    .set({ status: 'Inquisitor', minRank: 'Inquisitor', expiresAt: null, updatedAt: utc(now) })
    .where('id', '=', itemId)
    .execute();
}

export async function castVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string },
  deps: QueueDeps
): Promise<CastVoteResult> {
  const now = deps.now();
  await ensureMonthPartition(db, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

  const { result, settledItemId } = await db
    .transaction()
    .execute(async (trx): Promise<{ result: CastVoteResult; settledItemId?: number }> => {
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
          'img.nsfwLevel as imageLevel',
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

      // A vote that weighs nothing could still be the one that tips a split into a decision.
      const weight = voteWeight({
        rank: player.rankType,
        level: levelForExp(player.exp),
        smites: Number(smites.n),
      });
      if (weight <= 0) return rejected('no-weight');

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
          weight,
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
        const winner = Number(decision.value);
        if (isBlockedLevel(winner) || isExcessiveDownRating(item.imageLevel, winner)) {
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
          resolvedFromLevel: writesBack ? item.imageLevel : null,
          appliedAt: writesBack ? null : utc(now),
          updatedAt: utc(now),
        })
        .where('id', '=', item.id)
        .execute();
      await gradeVotes(trx, item.id, decision.value);

      return { result: { status: 'resolved' }, settledItemId: writesBack ? item.id : undefined };
    });

  if (settledItemId !== undefined) await settleResolved(db, settledItemId, deps);
  return result;
}

async function readImageState(db: Executor, imageId: number): Promise<ImageState | null> {
  const image = await db
    .selectFrom('Image')
    .select([
      'nsfwLevel',
      'nsfwLevelLocked as locked',
      'ingestion',
      'blockedFor',
      sql<string | null>`"metadata"->>'nsfwLevelReason'`.as('lockReason'),
    ])
    .where('id', '=', imageId)
    .executeTakeFirst();
  return image ?? null;
}

type Reroute =
  | Exclude<WritebackDecision, { kind: 'apply' }>
  | { kind: 'inquisitor'; reason: 'attempts-exhausted' };

/**
 * Takes a settled item off the write-back path for good. Its votes were graded when it settled, so
 * they are graded again by what really decided the image: a moderator's current level, or nothing
 * when it is gone, or the Inquisitors' ruling still to come.
 */
async function reroute(db: Kysely<DB>, itemId: number, route: Reroute, now: Date) {
  await db.transaction().execute(async (trx) => {
    const left = {
      appliedAt: null,
      nextAttemptAt: null,
      updatedAt: utc(now),
    };
    if (route.kind === 'inquisitor') {
      await trx
        .updateTable('KnightsQueueItem')
        .set({
          ...left,
          status: 'Inquisitor',
          minRank: 'Inquisitor',
          expiresAt: null,
          resolvedValue: null,
          resolvedAt: null,
          resolvedBy: null,
          resolvedFromLevel: null,
          reason: route.reason,
        })
        .where('id', '=', itemId)
        .execute();
      await regradeVotes(trx, itemId, 'pending');
      return;
    }

    await trx
      .updateTable('KnightsQueueItem')
      .set({
        ...left,
        status: 'Closed',
        reason: route.kind === 'moderator' ? 'moderator-ruled' : 'missing',
      })
      .where('id', '=', itemId)
      .execute();
    await regradeVotes(
      trx,
      itemId,
      route.kind === 'moderator' ? { correctAnswer: String(route.level) } : 'inconclusive'
    );
  });
}

function rerouteForSkip(
  outcome: Extract<ApplyOutcome, { outcome: 'skipped' }>
): Exclude<WritebackDecision, { kind: 'apply' }> {
  if (outcome.reason === 'missing') return { kind: 'missing' };
  if (outcome.reason === 'locked' && outcome.currentLevel && outcome.currentLevel > 0) {
    return { kind: 'moderator', level: outcome.currentLevel };
  }
  return { kind: 'inquisitor', reason: outcome.reason === 'blocked' ? 'blocked' : 'level-moved' };
}

type SettleOutcome = 'applied' | 'failed' | 'rerouted' | 'unclaimed';

/**
 * One try at writing a settled rating back. The claim bumps the attempt count and leases the item, so
 * a second job run or the vote that just settled it cannot write it twice. The image is looked at
 * first: if it was blocked, ruled by a moderator or has moved since the players settled, the rating is
 * not written (and the main app refuses it again anyway). Only a throw is transient.
 */
async function settleResolved(
  db: Kysely<DB>,
  itemId: number,
  deps: QueueDeps
): Promise<SettleOutcome> {
  const now = deps.now();
  const claimed = await db
    .updateTable('KnightsQueueItem')
    .set({
      applyAttempts: sql<number>`"applyAttempts" + 1`,
      nextAttemptAt: utc(addMinutes(now, LEASE_MINUTES)),
      updatedAt: utc(now),
    })
    .where('id', '=', itemId)
    .where('status', '=', 'Resolved')
    .where('appliedAt', 'is', null)
    .where('resolvedValue', 'is not', null)
    .where('resolvedBy', 'is not', null)
    .where((eb) => eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', utc(now))]))
    .returning([
      'questionKey',
      'imageId',
      'resolvedValue',
      'resolvedBy',
      'resolvedFromLevel',
      'applyAttempts',
    ])
    .executeTakeFirst();
  if (!claimed) return 'unclaimed';

  const decision = decideWriteback(
    await readImageState(db, claimed.imageId),
    claimed.resolvedFromLevel
  );
  if (decision.kind !== 'apply') {
    await reroute(db, itemId, decision, now);
    return 'rerouted';
  }

  try {
    const outcome = await deps.applyConsensus({
      questionKey: claimed.questionKey,
      imageId: claimed.imageId,
      value: claimed.resolvedValue as string,
      actorId: claimed.resolvedBy as number,
    });
    if (outcome.outcome === 'skipped') {
      await reroute(db, itemId, rerouteForSkip(outcome), now);
      return 'rerouted';
    }
    await db
      .updateTable('KnightsQueueItem')
      .set({ appliedAt: utc(deps.now()), nextAttemptAt: null })
      .where('id', '=', itemId)
      .execute();
    return 'applied';
  } catch (error) {
    console.error('knights: could not write a settled answer back, it will be retried', {
      itemId,
      attempt: claimed.applyAttempts,
      error,
    });
    if (claimed.applyAttempts >= MAX_APPLY_ATTEMPTS) {
      await reroute(db, itemId, { kind: 'inquisitor', reason: 'attempts-exhausted' }, now);
      return 'rerouted';
    }
    await db
      .updateTable('KnightsQueueItem')
      .set({ nextAttemptAt: utc(addMinutes(now, backoffMinutes(claimed.applyAttempts))) })
      .where('id', '=', itemId)
      .execute();
    return 'failed';
  }
}

/**
 * Retries every settled answer whose next try is due, fresh ones before those that have already
 * failed, so a few stuck rows cannot starve newer ones. A run stops starting tries once its time
 * budget is spent; what is left is picked up by the next run.
 */
export async function applyPendingResolutions(
  db: Kysely<DB>,
  deps: QueueDeps,
  {
    limit = 100,
    concurrency = 4,
    budgetMs = 45_000,
  }: { limit?: number; concurrency?: number; budgetMs?: number } = {}
): Promise<{ applied: number; failed: number; rerouted: number }> {
  const due = await db
    .selectFrom('KnightsQueueItem')
    .select('id')
    .where('status', '=', 'Resolved')
    .where('appliedAt', 'is', null)
    .where('resolvedValue', 'is not', null)
    .where('resolvedBy', 'is not', null)
    .where((eb) =>
      eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', utc(deps.now()))])
    )
    .orderBy('applyAttempts', 'asc')
    .orderBy('resolvedAt', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();

  const counts = { applied: 0, failed: 0, rerouted: 0 };
  const startedAt = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < due.length && Date.now() - startedAt < budgetMs) {
      const outcome = await settleResolved(db, due[next++].id, deps);
      if (outcome !== 'unclaimed') counts[outcome]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
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
