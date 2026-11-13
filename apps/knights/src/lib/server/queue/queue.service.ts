import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import { gradeKnightsVotes } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  KNIGHTS_STAGE_TTL_HOURS,
  type KnightsEscalationReason,
} from '@civitai/shared/new-order';
import { PROGRESSION } from '../progression/config';
import { mirrorXp, type XpDelta, type XpMirror } from '../progression/legacy-exp';
import { settleAndMirror, settleItemVotes } from '../progression/progression';
import { servableImage } from '@civitai/db/knights';
import { voteLockUntil, type VoteLimit } from './vote-rate';
import { votePartitionName } from './vote-partition';
import { RANKS, rankIndex, type Rank } from '../ranks';
import { heldSql } from '../conversion/held';
import { metrics } from '../metrics';
import { creditVote, insertVote, lockPlayerVoting } from './vote-record';
import {
  ESCALATION_PATH,
  FEED_STRETCH_SIZE,
  isStageRank,
  nextStaffedRank,
  stagesWorkedBy,
} from './ranks';
import { SMITES } from '../smites/config';
import {
  BUCKET_LEVELS,
  FEED,
  itemBucket,
  lowestTierPerItem,
  orderFeed,
  TIER_ESCALATED,
  TIER_NORMAL,
  type LevelBucket,
} from './feed';
import { stageDecisionRule, votesNeededAt } from './stage-rules';
import {
  decideChoice,
  decideWriteback,
  isBlockedLevel,
  isExcessiveDownRating,
  type ImageState,
  type WeightedAnswer,
  type WritebackDecision,
} from './resolution';

export { lockPlayerVoting };

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
  | 'bad-block-reason'
  | 'already-voted'
  | 'no-weight'
  | 'reset-pending';

export type CastVoteResult =
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'limited'; until: Date }
  | { status: 'recorded' | 'resolved' | 'escalated' | 'inquisitor' };

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 3_600_000);
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

export function servableItems(db: Executor) {
  return (
    db
      .selectFrom('KnightsQueueItem as i')
      .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
      .innerJoin('Image as img', 'img.id', 'i.imageId')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .where('i.status', '=', 'Open')
      .where('i.isHiddenCheck', '=', false)
      // Yes/no questions are served and answered by the yesno module, never as ratings.
      .where('i.audience', 'is', null)
      .where('q.active', '=', true)
      .where(servableImage)
  );
}

/** The latest buckets the player judged within the recent window, newest first, read from the ledger (hidden checks included). */
async function recentBuckets(db: Executor, userId: number, now: Date) {
  const rows = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('Image as img', 'img.id', 'v.imageId')
    .leftJoin('KnightsQueueItem as it', 'it.id', 'v.itemId')
    .select(['it.prediction', 'img.nsfwLevel'])
    .where('v.playerId', '=', userId)
    .where('v.createdAt', '>', utc(addHours(now, -FEED.recentJudgedHours)))
    .orderBy('v.createdAt', 'desc')
    .limit(FEED.recentJudged)
    .execute();
  return rows.map((r) => itemBucket(r.prediction, r.nsfwLevel));
}

const levelList = sql.join(BUCKET_LEVELS.map((level) => sql.lit(level)));
const textLevelList = sql.join(BUCKET_LEVELS.map((level) => sql.lit(String(level))));

/**
 * `itemBucket` as SQL, as the bucket's level flag (0 for none): `prediction.value` when it is a level flag (a number,
 * or a plain integer string), else the image's level. Expects `KnightsQueueItem as i` and `Image as img`.
 */
export const bucketLevelSql = sql<number>`CASE
  WHEN jsonb_typeof(i.prediction -> 'value') = 'number'
    AND (i.prediction ->> 'value')::numeric IN (${levelList})
    THEN (i.prediction ->> 'value')::numeric::int
  WHEN jsonb_typeof(i.prediction -> 'value') = 'string'
    AND (i.prediction ->> 'value') IN (${textLevelList})
    THEN (i.prediction ->> 'value')::int
  WHEN img."nsfwLevel" IN (${levelList}) THEN img."nsfwLevel"
  ELSE 0
END`;

/**
 * One stage's candidates, read in index order: one read of the items escalated within the priority window (skipped at
 * the entry stage, where nothing is escalated), then the stage's normal order (priority, age) per level bucket. Each
 * bucket read stops at `FEED.bucketWindowSize`, so a crowded bucket cannot push the others out of the window; the
 * caller buckets the escalated rows with `itemBucket`. An item whose level has no bucket is read only once escalated.
 * No read includes an image the player has already judged for the question, at any stage or in any earlier item.
 */
function stageWindow(
  db: Executor,
  userId: number,
  stage: Rank,
  exclude: number[],
  escalatedSince: Date
) {
  const candidates = () =>
    servableItems(db)
      .where('i.minRank', '=', stage)
      .$if(exclude.length > 0, (qb) => qb.where('i.id', 'not in', exclude))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsVote as v')
              .select(sql<number>`1`.as('one'))
              .where('v.playerId', '=', userId)
              .whereRef('v.imageId', '=', 'i.imageId')
              .whereRef('v.questionKey', '=', 'i.questionKey')
          )
        )
      )
      .select([
        'i.id',
        'q.key as questionKey',
        'q.kind',
        'q.prompt',
        'q.options',
        'i.priority',
        'i.createdAt',
        'i.prediction',
        'img.url as imageKey',
        'img.width',
        'img.height',
        'img.nsfwLevel as imageLevel',
      ]);

  const normal = BUCKET_LEVELS.map((level) =>
    candidates()
      .where((eb) => eb(bucketLevelSql, '=', level))
      .select(sql<number>`${sql.lit(TIER_NORMAL)}`.as('tier'))
      .orderBy('i.priority', 'asc')
      .orderBy('i.createdAt', 'asc')
      .orderBy('i.id', 'asc')
      .limit(FEED.bucketWindowSize)
  );
  const escalated =
    stage === ESCALATION_PATH[0]
      ? []
      : [
          candidates()
            .select(sql<number>`${sql.lit(TIER_ESCALATED)}`.as('tier'))
            .where('i.escalatedAt', '>', utc(escalatedSince))
            .orderBy('i.escalatedAt', 'asc')
            .orderBy('i.id', 'asc')
            .limit(FEED.bucketWindowSize * BUCKET_LEVELS.length),
        ];
  // Each read is wrapped so its ORDER BY and LIMIT stay its own inside the UNION ALL.
  const [first, ...rest] = [...escalated, ...normal].map((read) =>
    db.selectFrom(read.as('w')).selectAll()
  );
  return rest.reduce((query, read) => query.unionAll(read), first).execute();
}

/**
 * What a player is served next: the highest stage they may judge that has an open item they have not judged,
 * escalated items first for a day, then by priority and age; within that, a pick that varies the level bucket from
 * what they judged lately, in an order that differs per player. A stretch holds one question's items.
 */
export async function getFeed(
  db: Executor,
  userId: number,
  {
    limit = FEED_STRETCH_SIZE,
    exclude = [],
    now = new Date(),
    random = Math.random,
  }: { limit?: number; exclude?: number[]; now?: Date; random?: () => number } = {}
): Promise<Feed | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const stages = player ? stagesWorkedBy(player.rankType) : [];
  const escalatedSince = addHours(now, -FEED.escalationPriorityHours);

  let question: Feed['question'] | null = null;
  let recent: (LevelBucket | null)[] | null = null;
  const items: Feed['items'] = [];

  for (const stage of [...stages].reverse()) {
    if (items.length >= limit) break;
    const rows = lowestTierPerItem(
      await stageWindow(db, userId, stage, exclude, escalatedSince)
    ).sort(
      (a, b) =>
        a.tier - b.tier || a.priority - b.priority || +a.createdAt - +b.createdAt || a.id - b.id
    );
    const lead = rows[0];
    if (lead && !question) {
      question = {
        key: lead.questionKey,
        kind: lead.kind,
        prompt: lead.prompt,
        options: lead.options as QuestionOption[],
      };
    }
    const pool = rows
      .filter((r) => r.questionKey === (question as Feed['question'] | null)?.key)
      .map((r) => ({
        ...r,
        createdAt: +r.createdAt,
        bucket: itemBucket(r.prediction, r.imageLevel),
      }));
    if (pool.length === 0) continue;

    if (recent === null && new Set(pool.map((c) => c.bucket)).size > 1) {
      recent = await recentBuckets(db, userId, now);
    }
    const served: typeof pool = orderFeed(pool, {
      playerId: userId,
      recent: recent ?? [],
      random,
      limit: limit - items.length,
    });
    recent = [...served.map((r) => r.bucket).reverse(), ...(recent ?? [])].slice(
      0,
      FEED.recentJudged
    );
    for (const r of served) {
      items.push({ id: r.id, imageKey: r.imageKey, width: r.width, height: r.height });
    }
  }

  return question && items.length > 0 ? { question, items } : null;
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

/**
 * A player counts as serving only if they voted within this many days. A rank held by idle accounts would otherwise
 * make an item wait for people who are not there.
 */
export const ACTIVE_PLAYER_DAYS = 14;

/**
 * The stages someone can serve: a stage counts when an eligible player holds its rank or a higher one, as `canVote` lets
 * a higher rank judge a lower stage. Eligible means a vote within `ACTIVE_PLAYER_DAYS` and no career reset pending
 * (see `insertVote`). At most one query per rank, top down, so a job asks once and not per item. A stage can still be unservable for one item whose
 * only candidates already judged its image; `escalateExpired` bounds that wait.
 */
export async function staffedRanks(db: Executor, now: Date): Promise<Set<string>> {
  const since = utc(addHours(now, -24 * ACTIVE_PLAYER_DAYS));
  // Only the highest rank with an eligible player matters, so probe from the top and stop at the first hit.
  for (const rank of ['Paladin', 'Templar', 'Knight'] as const) {
    const hit = await db
      .selectFrom('NewOrderPlayer as p')
      .select('p.userId')
      .where('p.rankType', '=', rank)
      // A held player's votes decide nothing, so a rank only they serve is not served.
      .where(sql<SqlBool>`NOT ${heldSql('p.userId')}`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('KnightsVote as v')
            .select(sql<number>`1`.as('one'))
            .whereRef('v.playerId', '=', 'p.userId')
            .where('v.createdAt', '>', since)
        )
      )
      .where(
        (eb) =>
          eb
            .selectFrom('NewOrderSmite as s')
            .select((sb) => sb.fn.countAll().as('n'))
            .whereRef('s.targetPlayerId', '=', 'p.userId')
            .where('s.cleansedAt', 'is', null),
        '<',
        SMITES.max
      )
      .limit(1)
      .executeTakeFirst();
    if (hit) {
      return new Set(RANKS.filter((r) => isStageRank(r) && rankIndex(r) <= rankIndex(rank)));
    }
  }
  return new Set();
}

async function escalate(
  trx: Executor,
  item: { id: number; minRank: string },
  now: Date,
  staffed: ReadonlySet<string>
): Promise<'escalated' | 'inquisitor'> {
  const next = nextStaffedRank(item.minRank, staffed);
  if (next && next !== 'Inquisitor') {
    await trx
      .updateTable('KnightsQueueItem')
      .set({
        minRank: next,
        votesNeeded: votesNeededAt(next),
        escalatedAt: utc(now),
        expiresAt: utc(addHours(now, KNIGHTS_STAGE_TTL_HOURS)),
        updatedAt: utc(now),
      })
      .where('id', '=', item.id)
      .execute();
    metrics.escalation('next-stage');
    return 'escalated';
  }
  await toInquisitor(trx, item.id, now, 'no-consensus');
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

async function toInquisitor(
  trx: Executor,
  itemId: number,
  now: Date,
  escalationReason: KnightsEscalationReason
) {
  await trx
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Inquisitor',
      minRank: 'Inquisitor',
      escalationReason,
      expiresAt: null,
      updatedAt: utc(now),
    })
    .where('id', '=', itemId)
    .execute();
  metrics.escalation(escalationReason);
}

export async function lockItemVoters(trx: Executor, itemId: number) {
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
  await lockPlayerVoting(trx, input.userId);
  return voteLockUntil(trx, input.userId, now, deps.voteLimits);
}

export async function castVote(
  db: Kysely<DB>,
  input: {
    userId: number;
    itemId: number;
    answer: string;
    blockReason?: string | null;
    isModerator?: boolean;
  },
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

        // Ahead of every row lock, so a player's votes always queue in one order (see `insertVote`).
        await lockPlayerVoting(trx, input.userId);
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

        const decision = decideChoice(
          stageVotes,
          stageDecisionRule(item.minRank, item.votesNeeded)
        );
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
          return {
            result: { status: await escalate(trx, item, now, await staffedRanks(trx, now)) },
            xp: [voted],
          };
        }

        if (writesBack) {
          const winner = Number(decision.value);
          if (isBlockedLevel(winner) || isExcessiveDownRating(item.imageLevel, winner)) {
            await toInquisitor(
              trx,
              item.id,
              now,
              isBlockedLevel(winner) ? 'blocked' : 'pushed-down'
            );
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
        metrics.itemResolved(item.minRank);
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

type Reroute = Exclude<WritebackDecision, { kind: 'apply' }>;

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
      metrics.escalation(route.reason);
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

/**
 * Moves items whose stage window lapsed. An item with votes is handed up: to the next stage someone can serve, or to the Inquisitors.
 * An item with no counted vote (a held player's weighs 0; an earlier stage's does not count) at its stage may have had no one to answer
 * it, so it gets one more window at the same stage, until two stage windows after it entered the stage. After that it closes as
 * `expired`: unvoted overflow must not become moderator work. At a stage nobody serves there is no extension; such an item is handed up
 * when a later stage is served, and expires when the hand-up would reach the Inquisitors.
 */
export async function escalateExpired(
  db: Kysely<DB>,
  { now, limit = 200 }: { now: Date; limit?: number }
): Promise<{ escalated: number; toInquisitor: number; extended: number; expired: number }> {
  const result = await db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('KnightsQueueItem')
      .select(['id', 'minRank', 'escalatedAt', 'createdAt'])
      .where('status', '=', 'Open')
      .where('expiresAt', '<=', utc(now))
      .orderBy('expiresAt', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    const counts = { escalated: 0, toInquisitor: 0, extended: 0, expired: 0 };
    if (due.length === 0) return counts;

    const voted = new Set(
      (
        await trx
          .selectFrom('KnightsVote as v')
          .innerJoin('KnightsQueueItem as i', (join) =>
            join.onRef('i.id', '=', 'v.itemId').onRef('i.minRank', '=', 'v.stage')
          )
          .select('v.itemId')
          .distinct()
          // A held player's vote (weight 0) decides nothing, so an item with only those had no vote.
          .where('v.weight', '>', 0)
          .where(
            'v.itemId',
            'in',
            due.map((item) => item.id)
          )
          .execute()
      ).map((row) => row.itemId)
    );
    const staffed = await staffedRanks(trx, now);

    // An item extends only until two stage windows after it entered the stage (a custom shorter first `expiresAt` can extend
    // twice within that): one that sat that long with no vote is not coming back, and must not wait here forever (the one
    // player who could serve it may have judged it already).
    const enteredSince = addHours(now, -2 * KNIGHTS_STAGE_TTL_HOURS);
    const extend = (item: (typeof due)[number]) =>
      !voted.has(item.id) &&
      staffed.has(item.minRank) &&
      (item.escalatedAt ?? item.createdAt) > enteredSince;

    const idle = due.filter(extend);
    if (idle.length > 0) {
      await trx
        .updateTable('KnightsQueueItem')
        .set({ expiresAt: utc(addHours(now, KNIGHTS_STAGE_TTL_HOURS)), updatedAt: utc(now) })
        .where(
          'id',
          'in',
          idle.map((item) => item.id)
        )
        .execute();
      counts.extended = idle.length;
    }

    const expire = (item: (typeof due)[number]) => {
      if (voted.has(item.id) || extend(item)) return false;
      if (staffed.has(item.minRank)) return true;
      const next = nextStaffedRank(item.minRank, staffed);
      return !next || next === 'Inquisitor';
    };
    const lapsed = due.filter(expire);
    if (lapsed.length > 0) {
      // Votes are only graded here: `settleFinalItems`, next in the tick, pays them one item at a time, so one bad settlement
      // cannot roll back this batch, and player rows are not locked while every item lock is held.
      await closeItems(
        trx,
        lapsed.map((item) => item.id),
        now,
        'expired'
      );
      counts.expired = lapsed.length;
    }

    for (const item of due) {
      if (extend(item) || expire(item)) continue;
      const outcome = await escalate(trx, item, now, staffed);
      if (outcome === 'escalated') counts.escalated++;
      else counts.toInquisitor++;
    }
    return counts;
  });
  for (let i = 0; i < result.expired; i++) metrics.escalation('expired');
  return result;
}

/** Closes items with no outcome: no label and nothing written back. Pending votes become `inconclusive`; settling them is the caller's. */
async function closeItems(trx: Transaction<DB>, itemIds: number[], now: Date, reason?: string) {
  await trx
    .updateTable('KnightsQueueItem')
    .set({ status: 'Closed', updatedAt: utc(now), ...(reason ? { reason } : {}) })
    .where('id', 'in', itemIds)
    .execute();
  await trx
    .updateTable('KnightsVote')
    .set({ verdict: 'inconclusive' })
    .where('itemId', 'in', itemIds)
    .where('verdict', '=', 'pending')
    .execute();
}

export async function closeWithoutOutcome(db: Kysely<DB>, itemId: number, now: Date) {
  await db.transaction().execute(async (trx) => {
    await closeItems(trx, [itemId], now);
    await settleItemVotes(trx, itemId, now);
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

type Month = { year: number; month: number };

export async function ensureMonthPartition(db: Kysely<DB>, { year, month }: Month): Promise<void> {
  const name = votePartitionName({ year, month });
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
