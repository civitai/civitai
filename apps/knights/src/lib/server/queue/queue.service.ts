import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import { gradeKnightsVotes } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { NsfwLevel } from '@civitai/shared';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  KNIGHTS_STAGE_MAX_HOURS,
  KNIGHTS_STAGE_TTL_HOURS,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
  type KnightsEscalationReason,
} from '@civitai/shared/new-order';
import { PROGRESSION } from '../progression/config';
import { mirrorXp, type XpDelta, type XpMirror } from '../progression/legacy-exp';
import { settleAndMirror, settleItemVotes } from '../progression/progression';
import {
  ESCALATED_FROM_LEVEL_META_KEY,
  servableImage,
  servableImageContent,
} from '@civitai/db/knights';
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
  hasBlockMarker,
  isBlockedLevel,
  isExcessiveDownRating,
  moderatorRuling,
  mostVotedLevel,
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

/** An item as it stood before a step moved it off its stage: what the live queue drops are worked out from. */
export type MovedItem = { id: number; status: string; minRank: string };

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
  | 'own-image'
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

/** Rows the first round of a stage's normal-order scan reads; each later round reads twice as many as the one before. */
export const STAGE_SCAN_FIRST_ROUND = FEED.bucketWindowSize * BUCKET_LEVELS.length * 2;

/**
 * One stage's candidates: one read of the items escalated within the priority window (skipped at the entry stage, where
 * nothing is escalated), then the first `FEED.bucketWindowSize` items of each level bucket in the stage's normal order
 * (priority, age, id), so a crowded bucket cannot push the others out of the window. The caller buckets the escalated
 * rows with `itemBucket`. An item whose level has no bucket is read only once escalated. No read includes an image the
 * player has already judged for the question, at any stage or in any earlier item.
 *
 * The normal order is one scan of the stage in rounds that continue after the last row read, stopping once every bucket
 * is full or the stage runs out. Most open items can be unservable (a draft or scheduled post, a deleted image), and
 * only the Image and Post rows tell, so a read per bucket would walk the whole stage once per bucket. A bucket that
 * cannot fill makes the scan read every candidate of the stage, so the rounds read only what bucketing and the cursor
 * need, and one more read fetches the served columns of the kept items alone.
 */
async function stageWindow(
  db: Executor,
  userId: number,
  stage: Rank,
  exclude: number[],
  escalatedSince: Date
) {
  const eligible = () =>
    servableItems(db)
      .where('i.minRank', '=', stage)
      .where('img.userId', 'is distinct from', userId)
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
      );
  const candidates = () =>
    eligible().select([
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

  const escalated =
    stage === ESCALATION_PATH[0]
      ? []
      : await candidates()
          .select(sql<number>`${sql.lit(TIER_ESCALATED)}`.as('tier'))
          .where('i.escalatedAt', '>', utc(escalatedSince))
          .orderBy('i.escalatedAt', 'asc')
          .orderBy('i.id', 'asc')
          .limit(FEED.bucketWindowSize * BUCKET_LEVELS.length)
          .execute();

  const kept: number[] = [];
  const taken = new Map<LevelBucket | null, number>();
  let filled = 0;
  let after: StageScanCursor | null = null;
  for (let size = STAGE_SCAN_FIRST_ROUND; ; size *= 2) {
    const cursor: StageScanCursor | null = after;
    const rows = await eligible()
      .select([
        'i.id',
        'i.priority',
        // createdAt is TIMESTAMP(3); this text names the exact stored value whatever the host or session time zone.
        sql<string>`to_char(i."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS')`.as('createdAtKey'),
        'i.prediction',
        'img.nsfwLevel as imageLevel',
      ])
      .where((eb) => eb(bucketLevelSql, '!=', 0))
      // (priority, createdAt, id) is unique and never changes on a row, so a round starts exactly after the last one.
      // The cursor carries the last row's own values, so it holds even if that row is gone by the next round.
      .$if(cursor !== null, (qb) => {
        const c = cursor as StageScanCursor;
        return qb.where(
          sql<SqlBool>`(i.priority, i."createdAt", i.id) > (${c.priority}, ${c.createdAt}::timestamp, ${c.id})`
        );
      })
      .orderBy('i.priority', 'asc')
      .orderBy('i.createdAt', 'asc')
      .orderBy('i.id', 'asc')
      .limit(size)
      .execute();
    for (const row of rows) {
      const bucket = itemBucket(row.prediction, row.imageLevel);
      const count = taken.get(bucket) ?? 0;
      if (count >= FEED.bucketWindowSize) continue;
      taken.set(bucket, count + 1);
      if (count + 1 === FEED.bucketWindowSize) filled++;
      kept.push(row.id);
    }
    if (rows.length < size || filled === BUCKET_LEVELS.length) break;
    // Annotated so the cursor's type does not depend on the rows its own round read.
    const last: { id: number; priority: number; createdAtKey: string } = rows[rows.length - 1];
    after = { priority: last.priority, createdAt: last.createdAtKey, id: last.id };
  }

  // A kept item that stops being a candidate before this read (judged, closed, unservable) is left out, as if the scan
  // had run a moment later and found it so.
  const position = new Map(kept.map((id, n) => [id, n]));
  const normal =
    kept.length === 0
      ? []
      : (
          await candidates()
            .select(sql<number>`${sql.lit(TIER_NORMAL)}`.as('tier'))
            .where('i.id', 'in', kept)
            .execute()
        ).sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return [...escalated, ...normal];
}

type StageScanCursor = { priority: number; createdAt: string; id: number };

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

/** `reason` of a rating item re-rated to its most-voted level because its last stage reached no consensus (`rerate`). */
export const NO_CONSENSUS_RERATE_REASON = 'no-consensus-rerate';

type SplitItem = { id: number; minRank: string; questionKey: string; imageId: number };

/** Only the rating question is re-rated at the end of the path; any other choice question still goes to the Inquisitors. */
const reratesAtEnd = (item: Pick<SplitItem, 'questionKey'>) =>
  item.questionKey === KNIGHTS_NSFW_LEVEL_QUESTION;

async function escalate(
  trx: Transaction<DB>,
  item: SplitItem,
  now: Date,
  staffed: ReadonlySet<string>
): Promise<'escalated' | 'inquisitor' | 'rerated'> {
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
  if (reratesAtEnd(item)) return rerate(trx, item, now);
  await toInquisitor(trx, item.id, now, 'no-consensus');
  return 'inquisitor';
}

/**
 * Re-rates a no-consensus rating to its most-voted level, down as well as up (the pushed-down check is skipped). A Blocked pick
 * goes to the Inquisitors. Leaves the item Resolved and unwritten for `settleResolved`; the caller guarantees a counted vote at
 * its stage.
 */
async function rerate(
  trx: Transaction<DB>,
  item: SplitItem,
  now: Date
): Promise<'inquisitor' | 'rerated'> {
  const votes = await trx
    .selectFrom('KnightsVote')
    .select(['answer', 'weight', 'playerId'])
    .where('itemId', '=', item.id)
    .where('stage', '=', item.minRank)
    .orderBy('createdAt', 'desc')
    .orderBy('playerId', 'desc')
    .execute();
  const level = mostVotedLevel(votes);
  if (level === null) throw new Error(`item ${item.id} has no counted vote to re-rate by`);
  if (isBlockedLevel(Number(level))) {
    await toInquisitor(trx, item.id, now, 'blocked');
    return 'inquisitor';
  }

  const image = await trx
    .selectFrom('Image')
    .select('nsfwLevel')
    .where('id', '=', item.imageId)
    .executeTakeFirst();
  // The write-back's actor: the latest counted voter who gave the level (the backfill picks the same one).
  const actor = votes.find(
    (vote) => vote.weight > 0 && vote.answer === level
  ) as (typeof votes)[number];
  await trx
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Resolved',
      resolvedValue: level,
      resolvedAt: utc(now),
      resolvedBy: actor.playerId,
      resolvedFromLevel: image?.nsfwLevel ?? null,
      appliedAt: null,
      reason: NO_CONSENSUS_RERATE_REASON,
      updatedAt: utc(now),
    })
    .where('id', '=', item.id)
    .execute();
  await setVotesAside(trx, [item.id]);
  metrics.escalation(NO_CONSENSUS_RERATE_REASON);
  return 'rerated';
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
      // A moderator ruling elsewhere can move the level later; the card shows what the Knights saw.
      meta: sql`COALESCE("meta", '{}'::jsonb) || jsonb_build_object(${sql.lit(
        ESCALATED_FROM_LEVEL_META_KEY
      )}, (SELECT "nsfwLevel" FROM "Image" WHERE "Image"."id" = "KnightsQueueItem"."imageId"))`,
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
          const outcome = await escalate(trx, item, now, await staffedRanks(trx, now));
          if (outcome !== 'rerated') return { result: { status: outcome }, xp: [voted] };
          return { result: { status: 'resolved' }, settledItemId: item.id, xp: [voted] };
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

const lockReasonSql = (metadata: 'metadata' | 'img.metadata') =>
  sql<string | null>`${sql.ref(metadata)}->>'nsfwLevelReason'`;

/** `moderatorRuling` giving a level, on an image with no `hasBlockMarker`, as SQL; change it with them. Expects `Image as img`. */
const moderatorRuledImageSql = (eb: ExpressionBuilder<DB & { img: DB['Image'] }, 'img'>) =>
  eb.and([
    eb('img.nsfwLevelLocked', '=', true),
    eb('img.nsfwLevel', 'not in', [0, NsfwLevel.Blocked]),
    eb('img.ingestion', '!=', 'Blocked'),
    eb('img.blockedFor', 'is', null),
    eb(lockReasonSql('img.metadata'), 'is distinct from', KNIGHTS_VOTE_NSFW_LEVEL_REASON),
  ]);

async function readImageState(db: Executor, imageId: number): Promise<ImageState | null> {
  const image = await db
    .selectFrom('Image')
    .select([
      'nsfwLevel',
      'nsfwLevelLocked as locked',
      'ingestion',
      'blockedFor',
      lockReasonSql('metadata').as('lockReason'),
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
  const xp = await db.transaction().execute((trx) => applyReroute(trx, itemId, route, now));
  await mirrorXp(mirror, xp);
}

async function applyReroute(
  trx: Transaction<DB>,
  itemId: number,
  route: Reroute,
  now: Date
): Promise<XpDelta[]> {
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
      ...(route.kind === 'moderator'
        ? { reason: 'moderator-ruled', resolvedValue: String(route.level) }
        : { reason: 'missing' }),
    })
    .where('id', '=', itemId)
    .execute();
  await regradeVotes(
    trx,
    itemId,
    route.kind === 'moderator' ? { correctAnswer: String(route.level) } : 'inconclusive'
  );
  return (await settleItemVotes(trx, itemId, now)).xp;
}

/**
 * Closes Open and Inquisitor rating items whose image a moderator has locked at a level (in any queue or tool), the way the
 * write-back closes a settled one on finding that lock (`moderatorRuling`). A blocked image, a lock without a level, a Blocked
 * consensus (a moderator must see that report whatever the lock says), and items in any other status (an Inquisitor ruling under
 * way is `Ruling`) are left to their own paths. Status and image are read again under the item row lock (the lock `castVote` and
 * the Inquisitor claim take), so the close uses the level as it is then. `sweptForRuling` is the TypeScript form of `sweptForRulingSql`.
 */
type SweptFields = { status: string; escalationReason: string | null; reason: string | null };
const sweptForRuling = (item: SweptFields) =>
  item.status === 'Open' ||
  (item.status === 'Inquisitor' &&
    item.escalationReason !== 'blocked' &&
    item.reason !== 'blocked');

const sweptForRulingSql = (eb: ExpressionBuilder<DB & { i: DB['KnightsQueueItem'] }, 'i'>) =>
  eb.or([
    eb('i.status', '=', 'Open'),
    eb.and([
      eb('i.status', '=', 'Inquisitor'),
      eb('i.escalationReason', 'is distinct from', 'blocked'),
      eb('i.reason', 'is distinct from', 'blocked'),
    ]),
  ]);

export async function closeModeratorRuledItems(
  db: Kysely<DB>,
  {
    now,
    limit = 200,
    mirror,
    moved,
  }: { now: Date; limit?: number; mirror?: XpMirror; moved?: (items: MovedItem[]) => void }
): Promise<{ closed: number; failed: number }> {
  // Narrowed to rows the rule closes, so rows it skips cannot fill the limit every tick.
  const candidates = await db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .select(['i.id', 'i.imageId', 'i.minRank'])
    .where(sweptForRulingSql)
    .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .where('i.audience', 'is', null)
    .where('i.isHiddenCheck', '=', false)
    .where(moderatorRuledImageSql)
    .orderBy('i.id', 'asc')
    .limit(limit)
    .execute();

  const counts = { closed: 0, failed: 0 };
  const closed: MovedItem[] = [];
  for (const { id, imageId, minRank } of candidates) {
    try {
      const result = await db.transaction().execute(async (trx) => {
        const item = await trx
          .selectFrom('KnightsQueueItem')
          .select(['status', 'escalationReason', 'reason'])
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!item || !sweptForRuling(item)) return null;
        const image = await readImageState(trx, imageId);
        const ruling = image && !hasBlockMarker(image) ? moderatorRuling(image) : null;
        if (ruling?.kind !== 'moderator') return null;
        return { status: item.status, xp: await applyReroute(trx, id, ruling, now) };
      });
      if (!result) continue;
      counts.closed++;
      closed.push({ id, status: result.status, minRank });
      await mirrorXp(mirror, result.xp);
    } catch (error) {
      counts.failed++;
      console.error('knights: could not close an item a moderator ruled, it will be retried', {
        itemId: id,
        error,
      });
    }
  }
  moved?.(closed);
  return counts;
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
 * Moves items whose stage window lapsed. An item with votes is handed up to the next stage someone can serve. At the end of the
 * path a rating is re-rated, or closes as `expired` below quorum (a Blocked pick goes to the Inquisitors).
 * An item with no counted vote (a held player's weighs 0; an earlier stage's does not count) at its stage may have had no one to answer
 * it, so it gets one more window at the same stage, until two stage windows after it entered the stage. After that it closes as
 * `expired`: unvoted overflow must not become moderator work. At a stage nobody serves there is no extension; such an item is handed up
 * when a later stage is served, and expires when the hand-up would reach the Inquisitors.
 */
export async function escalateExpired(
  db: Kysely<DB>,
  { now, limit = 200, moved }: { now: Date; limit?: number; moved?: (items: MovedItem[]) => void }
): Promise<{
  escalated: number;
  toInquisitor: number;
  extended: number;
  expired: number;
  rerated: number;
}> {
  let left: MovedItem[] = [];
  const result = await db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('KnightsQueueItem')
      .select(['id', 'minRank', 'escalatedAt', 'createdAt', 'questionKey', 'imageId'])
      .where('status', '=', 'Open')
      .where('expiresAt', '<=', utc(now))
      .orderBy('expiresAt', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    const counts = { escalated: 0, toInquisitor: 0, extended: 0, expired: 0, rerated: 0 };
    if (due.length === 0) return counts;

    // Counted votes at each item's stage. A held player's vote (weight 0) decides nothing, so an item with only those had no vote.
    const counted = new Map<number, WeightedAnswer[]>();
    const stageVotes = await trx
      .selectFrom('KnightsVote as v')
      .innerJoin('KnightsQueueItem as i', (join) =>
        join.onRef('i.id', '=', 'v.itemId').onRef('i.minRank', '=', 'v.stage')
      )
      .select(['v.itemId', 'v.answer', 'v.weight'])
      .where('v.weight', '>', 0)
      .where(
        'v.itemId',
        'in',
        due.map((item) => item.id)
      )
      .execute();
    for (const { itemId, ...vote } of stageVotes) {
      counted.set(itemId, [...(counted.get(itemId) ?? []), vote]);
    }
    const staffed = await staffedRanks(trx, now);

    // An item extends only until two stage windows after it entered the stage (a custom shorter first `expiresAt` can extend
    // twice within that): one that sat that long with no vote is not coming back, and must not wait here forever (the one
    // player who could serve it may have judged it already).
    const enteredSince = addHours(now, -KNIGHTS_STAGE_MAX_HOURS);
    const extend = (item: (typeof due)[number]) =>
      !counted.has(item.id) &&
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

    const leavesPlayers = (item: (typeof due)[number]) => {
      const next = nextStaffedRank(item.minRank, staffed);
      return !next || next === 'Inquisitor';
    };
    const expire = (item: (typeof due)[number]) => {
      if (extend(item)) return false;
      const votes = counted.get(item.id) ?? [];
      // A re-rate needs the stage's quorum: fewer counted votes than that decide nothing, as none would, unless they point at
      // Blocked, which `rerate` hands to the Inquisitors whatever the count.
      if (votes.length > 0) {
        return (
          reratesAtEnd(item) &&
          leavesPlayers(item) &&
          votes.length < votesNeededAt(item.minRank) &&
          !isBlockedLevel(Number(mostVotedLevel(votes)))
        );
      }
      return staffed.has(item.minRank) || leavesPlayers(item);
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

    left = due
      .filter((item) => !extend(item))
      .map((item) => ({ id: item.id, status: 'Open', minRank: item.minRank }));
    for (const item of due) {
      if (extend(item) || expire(item)) continue;
      const outcome = await escalate(trx, item, now, staffed);
      if (outcome === 'escalated') counts.escalated++;
      else if (outcome === 'rerated') counts.rerated++;
      else counts.toInquisitor++;
    }
    return counts;
  });
  for (let i = 0; i < result.expired; i++) metrics.escalation('expired');
  moved?.(left);
  return result;
}

/** `reason` of an item closed because its image, or the image's post, is gone (`closeUnservableItems`). */
export const UNSERVABLE_REASON = 'unservable';
/** `reason` of an open item closed because its image on a live post stopped being servable (`closeUnservableItems`). */
export const IMAGE_UNSERVABLE_REASON = 'image-unservable';
/** `reason` of an item closed because its post publishes only after the item would have expired (`closeUnservableItems`). */
export const PUBLISHES_AFTER_EXPIRY_REASON = 'publishes-after-expiry';
/** `reason` of an item closed because its post is still a draft long after queueing (`closeUnservableItems`). */
export const UNPUBLISHED_DRAFT_REASON = 'unpublished-draft';
/** Hours after queueing an item on a draft post (`publishedAt` null) is given to publish before `closeUnservableItems` closes it. */
export const UNPUBLISHED_DRAFT_HOURS = 24;
/** The main app's scan-sampling `source`: the only items `unpublished-draft` closes. */
export const SCAN_SAMPLE_SOURCE = 'scan-sample';

const hours = (n: number) => sql`${sql.lit(`${n} hours`)}::interval`;

/**
 * `knightsLatestStageEnd` (`@civitai/shared/new-order`) in SQL, for an item at its first stage (entered at `createdAt`); change
 * them together. Expects `KnightsQueueItem as i` with a non-null `expiresAt`.
 */
const latestStageEndSql = sql<Date>`CASE
  WHEN "i"."expiresAt" >= "i"."createdAt" + ${hours(KNIGHTS_STAGE_MAX_HOURS)} THEN "i"."expiresAt"
  WHEN "i"."expiresAt" >= "i"."createdAt" + ${hours(KNIGHTS_STAGE_TTL_HOURS)}
    THEN "i"."expiresAt" + ${hours(KNIGHTS_STAGE_TTL_HOURS)}
  ELSE "i"."createdAt" + ${hours(KNIGHTS_STAGE_MAX_HOURS + KNIGHTS_STAGE_TTL_HOURS)}
END`;

/**
 * Closes open rating items Knights can never serve, so they stop filling the queue until they expire. Each closes like `expired`:
 * no label, no write-back, leftover votes inconclusive (`settleFinalItems`, next in the tick, settles them unpaid).
 * - `unservable`: the image row is gone, or its post is (`Image.post` is `onDelete: SetNull`). Neither comes back. Also an item
 *   waiting on the Inquisitors (`Inquisitor`, or `Ruling` whose moderator lease has lapsed) whose image row is gone, which no
 *   moderator can rule on; an image an evidence hold kept with its post deleted still can, and so a ruling in progress, or an
 *   Inquisitor item whose image is merely blocked, is left alone.
 * - `image-unservable`: the post is live (published, not later than `now`) but the image fails `servableImageContent`: blocked,
 *   held for review, flagged poi/minor, or unrated, once scanned (ingestion `Scanned` or `Blocked`: a scan still to land may make
 *   it servable). The feed skips it, so it would only wait out its windows. A level a
 *   moderator locked is left to `closeModeratorRuledItems`, which runs first and grades the votes against it.
 * - `publishes-after-expiry`: the post is scheduled to publish after the latest moment the item could still be open
 *   (`latestStageEndSql`), so it would close as `expired` before any player could be served it. Only for an item still at the
 *   stage it was queued at (never escalated, `minRank` Knight, where nobody serving the stage means nobody serves any stage, so
 *   it expires instead of being handed up) with no counted vote there (a voted item is handed up, not expired). A draft has no
 *   date and is left to the next reason, as is an item that never expires.
 * - `unpublished-draft`: a scan sample (`SCAN_SAMPLE_SOURCE`) whose post is still a draft (`publishedAt` null) more than
 *   `UNPUBLISHED_DRAFT_HOURS` after the item was queued. Many drafts never publish, and until then the item only fills the
 *   queue; nothing re-queues it if the post publishes later. At any stage. An owner's rating on a draft is left open.
 * Hidden checks and yes/no items are never touched. At most `limit` items per call, shared by every reason, oldest item id
 * first; rows another transaction holds are skipped. `moved` gets the open items closed, after commit, so live updates drop
 * them from players' buffers.
 */
export async function closeUnservableItems(
  db: Kysely<DB>,
  {
    now,
    limit = 200,
    moved,
  }: { now: Date; limit?: number; moved?: (items: MovedItem[]) => void }
): Promise<{
  unservable: number;
  publishesAfterExpiry: number;
  unpublishedDrafts: number;
  imageUnservable: number;
}> {
  const closedOpen: MovedItem[] = [];
  const result = await db.transaction().execute(async (trx) => {
    // Primary-key lookups into Image and Post from the open and Inquisitor items: never a scan of either table.
    const due = await trx
      .selectFrom('KnightsQueueItem as i')
      .leftJoin('Image as img', 'img.id', 'i.imageId')
      .leftJoin('Post as p', 'p.id', 'img.postId')
      .select([
        'i.id',
        'i.status',
        'i.minRank',
        sql<boolean>`"p"."id" IS NULL`.as('gone'),
        sql<boolean>`"p"."id" IS NOT NULL AND "p"."publishedAt" IS NULL`.as('draft'),
        sql<boolean>`"p"."publishedAt" IS NOT NULL AND "p"."publishedAt" <= ${utc(now)}`.as('live'),
      ])
      // Narrows to the status index before the per-reason rules below.
      .where('i.status', 'in', ['Open', 'Inquisitor', 'Ruling'])
      .where('i.isHiddenCheck', '=', false)
      .where('i.audience', 'is', null)
      .where((eb) =>
        eb.or([
          // Also true when the image is gone: the Post join then has nothing to match.
          eb.and([eb('i.status', '=', 'Open'), eb('p.id', 'is', null)]),
          // Only the image row: an evidence hold keeps an image with its post deleted, and a moderator can still rule on it.
          eb.and([
            eb('img.id', 'is', null),
            eb.or([
              eb('i.status', '=', 'Inquisitor'),
              // The moderator app's claim (`RULING_LEASE_MS`): a lapsed lease is free to reclaim, a live one is a ruling in progress.
              eb.and([
                eb('i.status', '=', 'Ruling'),
                eb.or([eb('i.nextAttemptAt', 'is', null), eb('i.nextAttemptAt', '<=', utc(now))]),
              ]),
            ]),
          ]),
          eb.and([
            eb('i.status', '=', 'Open'),
            eb('p.publishedAt', 'is not', null),
            eb('p.publishedAt', '<=', utc(now)),
            // A scan still to land (or a rescan) may yet make it servable: an owner rating can be queued before it.
            eb('img.ingestion', 'in', ['Scanned', 'Blocked']),
            eb.not(servableImageContent(eb)),
            eb.not(moderatorRuledImageSql(eb)),
          ]),
          eb.and([
            eb('i.status', '=', 'Open'),
            eb('i.source', '=', SCAN_SAMPLE_SOURCE),
            eb('p.id', 'is not', null),
            eb('p.publishedAt', 'is', null),
            eb('i.createdAt', '<', utc(addHours(now, -UNPUBLISHED_DRAFT_HOURS))),
          ]),
          eb.and([
            eb('i.status', '=', 'Open'),
            eb('i.minRank', '=', 'Knight'),
            eb('i.escalatedAt', 'is', null),
            eb('i.expiresAt', 'is not', null),
            eb('p.publishedAt', '>', latestStageEndSql),
            // The vote `escalateExpired` counts: one at the item's stage with weight.
            eb.not(
              eb.exists(
                eb
                  .selectFrom('KnightsVote as v')
                  .select(sql`1`.as('one'))
                  .whereRef('v.itemId', '=', 'i.id')
                  .whereRef('v.stage', '=', 'i.minRank')
                  .where('v.weight', '>', 0)
              )
            ),
          ]),
        ])
      )
      .orderBy('i.id', 'asc')
      .limit(limit)
      .forUpdate('i')
      .skipLocked()
      .execute();

    const gone = due.filter((item) => item.gone).map((item) => item.id);
    const drafts = due.filter((item) => item.draft).map((item) => item.id);
    const live = due
      .filter((item) => !item.gone && !item.draft && item.live)
      .map((item) => item.id);
    const late = due
      .filter((item) => !item.gone && !item.draft && !item.live)
      .map((item) => item.id);
    if (gone.length > 0) await closeItems(trx, gone, now, UNSERVABLE_REASON);
    if (late.length > 0) await closeItems(trx, late, now, PUBLISHES_AFTER_EXPIRY_REASON);
    if (drafts.length > 0) await closeItems(trx, drafts, now, UNPUBLISHED_DRAFT_REASON);
    if (live.length > 0) await closeItems(trx, live, now, IMAGE_UNSERVABLE_REASON);
    for (const item of due)
      if (item.status === 'Open')
        closedOpen.push({ id: item.id, status: 'Open', minRank: item.minRank });
    return {
      unservable: gone.length,
      publishesAfterExpiry: late.length,
      unpublishedDrafts: drafts.length,
      imageUnservable: live.length,
    };
  });
  for (let i = 0; i < result.unservable; i++) metrics.escalation(UNSERVABLE_REASON);
  for (let i = 0; i < result.publishesAfterExpiry; i++)
    metrics.escalation(PUBLISHES_AFTER_EXPIRY_REASON);
  for (let i = 0; i < result.unpublishedDrafts; i++) metrics.escalation(UNPUBLISHED_DRAFT_REASON);
  for (let i = 0; i < result.imageUnservable; i++) metrics.escalation(IMAGE_UNSERVABLE_REASON);
  moved?.(closedOpen);
  return result;
}

/** Closes items with no outcome: no label and nothing written back. Pending votes become `inconclusive`; settling them is the caller's. */
async function closeItems(trx: Transaction<DB>, itemIds: number[], now: Date, reason?: string) {
  await trx
    .updateTable('KnightsQueueItem')
    .set({ status: 'Closed', updatedAt: utc(now), ...(reason ? { reason } : {}) })
    .where('id', 'in', itemIds)
    .execute();
  await setVotesAside(trx, itemIds);
}

/** Pending votes on the items become `inconclusive`: they never grade or pay beyond their XP at cast. */
async function setVotesAside(trx: Transaction<DB>, itemIds: number[]) {
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
