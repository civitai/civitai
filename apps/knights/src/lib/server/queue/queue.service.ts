import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import { gradeKnightsVotes } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION, KNIGHTS_STAGE_TTL_HOURS } from '@civitai/shared/new-order';
import { PROGRESSION } from '../progression/config';
import { mirrorXp, type XpDelta, type XpMirror } from '../progression/legacy-exp';
import { settleAndMirror, settleItemVotes } from '../progression/progression';
import { servableImage } from '@civitai/db/knights';
import { voteLockUntil, type VoteLimit } from './vote-rate';
import { RANKS, type Rank } from '../ranks';
import { creditVote, insertVote } from './vote-record';
import { FEED_STRETCH_SIZE, isStageRank, nextRank, stagesWorkedBy } from './ranks';
import {
  decideChoice,
  decideWriteback,
  isBlockedLevel,
  isExcessiveDownRating,
  type ImageState,
  type WeightedAnswer,
  type WritebackDecision,
} from './resolution';

export type ConsensusApplication = {
  questionKey: string;
  imageId: number;
  value: string;
  actorId: number;
};

export type ApplyOutcome =
  | { outcome: 'applied' }
  | { outcome: 'skipped'; reason: 'missing' | 'blocked' | 'locked'; currentLevel: number | null };

export type QueueDeps = {
  /** A throw is transient: the item stays settled and unapplied and is retried with backoff. A returned skip is final. */
  applyConsensus: (application: ConsensusApplication) => Promise<ApplyOutcome>;
  now: () => Date;
  /** Keeps the original game's exp counter in step; called after the Postgres commit, a failure is only logged. */
  mirrorXp?: XpMirror;
  /** Pacing for non-moderators; absent means unpaced. */
  voteLimits?: readonly VoteLimit[];
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
  | 'no-weight'
  | 'reset-pending';

export type CastVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'limited'; until: Date }
  | { status: 'recorded' | 'resolved' | 'escalated' | 'inquisitor' };

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000);
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

function servableItems(db: Executor) {
  return db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('i.status', '=', 'Open')
    .where('i.isHiddenCheck', '=', false)
    .where('q.active', '=', true)
    .where(servableImage);
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
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as h')
              .select(sql<number>`1`.as('one'))
              .where('h.itemId', '<', 0)
              .whereRef('h.imageId', '=', 'i.imageId')
              .where('h.playerId', '=', userId)
          )
        )
      )
      .orderBy(rankOrder, 'desc')
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

export async function enqueueItem(db: Executor, input: NewItem, now: Date): Promise<number> {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['minRank', 'votesToResolve'])
    .where('key', '=', input.questionKey)
    .executeTakeFirstOrThrow();
  const minRank = input.minRank ?? question.minRank;
  if (!isStageRank(minRank)) throw new Error(`"${minRank}" is not a rank an item can wait at`);
  const expiresAt =
    input.expiresAt === undefined ? addHours(now, KNIGHTS_STAGE_TTL_HOURS) : input.expiresAt;

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
        expiresAt: utc(addHours(now, KNIGHTS_STAGE_TTL_HOURS)),
        updatedAt: utc(now),
      })
      .where('id', '=', item.id)
      .execute();
    return 'escalated';
  }
  await toInquisitor(trx, item.id, now);
  return 'inquisitor';
}

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

async function lockItemVoters(trx: Executor, itemId: number) {
  await trx
    .selectFrom('NewOrderPlayer')
    .select('userId')
    .where('userId', 'in', (eb) =>
      eb.selectFrom('KnightsVote').select('playerId').where('itemId', '=', itemId)
    )
    .orderBy('userId', 'asc')
    .forUpdate()
    .execute();
}

const rankOrder = sql`CASE "i"."minRank" ${sql.join(
  RANKS.map((rank, index) => sql`WHEN ${sql.lit(rank)} THEN ${sql.lit(index)}`),
  sql` `
)} ELSE 0 END`;

/** First key of the per-player advisory lock that serialises a player's paced votes. */
const VOTE_PACING_LOCK_NAMESPACE = 7_301;

/**
 * When a paced player may answer again, or null. Pacing must hold across parallel requests, so one player's answers queue on an
 * advisory lock before they count the ledger. Take it ahead of every row lock; nothing else waits on it while holding a lock of
 * its own, so it cannot join a deadlock cycle.
 */
export async function pacingGate(
  trx: Transaction<DB>,
  input: { userId: number; isModerator?: boolean },
  now: Date,
  deps: Pick<QueueDeps, 'voteLimits'>
): Promise<Date | null> {
  if (!deps.voteLimits || input.isModerator) return null;
  await sql`SELECT pg_advisory_xact_lock(${VOTE_PACING_LOCK_NAMESPACE}, ${input.userId})`.execute(
    trx
  );
  return voteLockUntil(trx, input.userId, now, deps.voteLimits);
}

export async function castVote(
  db: Kysely<DB>,
  input: { userId: number; itemId: number; answer: string; isModerator?: boolean },
  deps: QueueDeps
): Promise<CastVoteResult> {
  const now = deps.now();
  await ensureMonthPartition(db, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });

  const { result, settledItemId, xp } = await db
    .transaction()
    .execute(
      async (trx): Promise<{ result: CastVoteResult; settledItemId?: number; xp?: XpDelta[] }> => {
        const rejected = (reason: RejectReason) => ({
          result: { status: 'rejected', reason } as const,
        });

        const until = await pacingGate(trx, input, now, deps);
        if (until) return { result: { status: 'limited', until } as const };

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

        const vote = await insertVote(
          trx,
          { ...input, now },
          {
            itemId: item.id,
            questionKey: item.questionKey,
            imageId: item.imageId,
            stage: item.minRank,
            options: item.options as QuestionOption[],
          }
        );
        if (vote.status === 'rejected') return rejected(vote.reason);

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
        const voted: XpDelta = { playerId: input.userId, xp: PROGRESSION.voteXp };
        const writesBack = item.questionKey === KNIGHTS_NSFW_LEVEL_QUESTION;

        // Settling updates every voter's player row in userId order. Taking the same locks first, before
        // the first player update of this transaction, keeps all transactions in one order and so deadlock-free.
        if (decision.kind === 'resolved' && !writesBack) await lockItemVoters(trx, item.id);
        await creditVote(trx, {
          userId: input.userId,
          itemId: item.id,
          now,
          player: vote.player,
          gold: vote.gold,
        });

        if (decision.kind === 'pending') return { result: { status: 'recorded' }, xp: [voted] };
        if (decision.kind === 'split') {
          return { result: { status: await escalate(trx, item, now) }, xp: [voted] };
        }

        if (writesBack) {
          const winner = Number(decision.value);
          if (isBlockedLevel(winner) || isExcessiveDownRating(item.imageLevel, winner)) {
            await toInquisitor(trx, item.id, now);
            return { result: { status: 'inquisitor' }, xp: [voted] };
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
        await gradeKnightsVotes(trx, item.id, decision.value);
        // Not yet written back: a reroute can still regrade these votes.
        const settled = writesBack ? undefined : await settleItemVotes(trx, item.id, now);

        return {
          result: { status: 'resolved' },
          settledItemId: writesBack ? item.id : undefined,
          xp: [voted, ...(settled?.xp ?? [])],
        };
      }
    );

  await mirrorXp(deps.mirrorXp, xp ?? []);

  if (settledItemId !== undefined) {
    // The vote is committed: a failure settling it must not tell the player it was lost. The item stays Resolved and unwritten, so the job retries it.
    await settleResolved(db, settledItemId, deps).catch((error) =>
      console.error('knights: could not settle a committed vote, the job will retry it', {
        itemId: settledItemId,
        error,
      })
    );
  }
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

/** Regrades the votes by what actually decided the image: a moderator's level, nothing if it is gone, or the pending Inquisitor ruling. */
async function reroute(
  db: Kysely<DB>,
  itemId: number,
  route: Reroute,
  now: Date,
  mirror?: XpMirror
) {
  const xp = await db.transaction().execute(async (trx): Promise<XpDelta[]> => {
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
      return [];
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
    return (await settleItemVotes(trx, itemId, now)).xp;
  });
  await mirrorXp(mirror, xp);
}

function rerouteForSkip(
  outcome: Extract<ApplyOutcome, { outcome: 'skipped' }>
): Exclude<WritebackDecision, { kind: 'apply' }> {
  if (outcome.reason === 'missing') return { kind: 'missing' };
  if (outcome.reason === 'blocked') return { kind: 'inquisitor', reason: 'blocked' };
  return outcome.currentLevel && outcome.currentLevel > 0
    ? { kind: 'moderator', level: outcome.currentLevel }
    : { kind: 'inquisitor', reason: 'moderator-locked' };
}

/** Resolved, unwritten, and not backing off or leased by another run. */
const dueForWriteback = (eb: ExpressionBuilder<DB, 'KnightsQueueItem'>, now: Date) =>
  eb.and([
    eb('status', '=', 'Resolved'),
    eb('appliedAt', 'is', null),
    eb('resolvedValue', 'is not', null),
    eb('resolvedBy', 'is not', null),
    eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', utc(now))]),
  ]);

type SettleOutcome = 'applied' | 'failed' | 'rerouted' | 'unclaimed';

/** `appliedAt` is committed on its own: a failing payout must not undo it and re-trigger the write-back. The tick sweep pays what this misses. */
async function markApplied(db: Kysely<DB>, itemId: number, now: Date, deps: QueueDeps) {
  await db
    .updateTable('KnightsQueueItem')
    .set({ appliedAt: utc(now), nextAttemptAt: null })
    .where('id', '=', itemId)
    .execute();
  await settleAndMirror(db, itemId, now, deps.mirrorXp).catch((error) =>
    console.error('knights: could not pay out a written-back item, the job will retry it', {
      itemId,
      error,
    })
  );
}

/** One write-back try. The claim leases the item so a concurrent run cannot write it twice; only a throw is transient. */
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
    .where((eb) => dueForWriteback(eb, now))
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

  const decision = decideWriteback(await readImageState(db, claimed.imageId), {
    resolvedFromLevel: claimed.resolvedFromLevel,
    resolvedValue: claimed.resolvedValue as string,
  });
  if (decision.kind === 'already-applied') {
    await markApplied(db, itemId, deps.now(), deps);
    return 'applied';
  }
  if (decision.kind !== 'apply') {
    await reroute(db, itemId, decision, now, deps.mirrorXp);
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
      await reroute(db, itemId, rerouteForSkip(outcome), now, deps.mirrorXp);
      return 'rerouted';
    }
    await markApplied(db, itemId, deps.now(), deps);
    return 'applied';
  } catch (error) {
    const log = { itemId, attempt: claimed.applyAttempts, error };
    if (claimed.applyAttempts >= MAX_APPLY_ATTEMPTS) {
      console.error(
        'knights: could not write a settled answer back, handing it to the Inquisitors',
        log
      );
      await reroute(
        db,
        itemId,
        { kind: 'inquisitor', reason: 'attempts-exhausted' },
        now,
        deps.mirrorXp
      );
      return 'rerouted';
    }
    console.error('knights: could not write a settled answer back, it will be retried', log);
    await db
      .updateTable('KnightsQueueItem')
      .set({ nextAttemptAt: utc(addMinutes(now, backoffMinutes(claimed.applyAttempts))) })
      .where('id', '=', itemId)
      .execute();
    return 'failed';
  }
}

/** Fresh rows go before already-failed ones so stuck rows cannot starve newer ones; stops starting tries once the time budget is spent. */
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
    .where((eb) => dueForWriteback(eb, deps.now()))
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
    await settleItemVotes(trx, itemId, now);
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

type Month = { year: number; month: number };

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

export async function ensureVotePartitions(
  db: Kysely<DB>,
  { now, monthsAhead }: { now: Date; monthsAhead: number }
): Promise<void> {
  for (let i = 0; i <= monthsAhead; i++) {
    await ensureMonthPartition(db, monthStart(now.getUTCFullYear(), now.getUTCMonth() + i));
  }
}

export type { Rank };
