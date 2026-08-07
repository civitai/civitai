import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { getBuzz } from './buzz';
import { getNotifications } from './notifications';
import { usersByIds } from './users.service';
import type { BuzzTransaction } from '../../routes/retool/user-lookup/buzz-history';

// Everything behind `/api/user-account`, plus the two endpoints that exist only because their query is
// slow enough to need its own: `/api/user-mod-activity` and `/api/user-buzz-history`.
//
// One file per endpoint is the rule for this page's services — see user-signals.service.ts.

// REVIEWS + COMMENTS (Retool's ReviewList / ComboComments), read-only.
//
// Retool paired these lists with bulk delete / ToS actions. Those are NOT ported: they are destructive,
// and the delete path carries side effects (search-index sync, cache busting) that the spoke does not own
// yet — see the account-actions note in the migration tracker.
export type UserReview = {
  id: number;
  createdAt: Date;
  rating: number | null;
  modelId: number | null;
  tosViolation: boolean | null;
  exclude: boolean | null;
  modelCreator: string | null;
};

export async function getReviews(userId: number, limit = 25): Promise<UserReview[]> {
  return dbRead
    .selectFrom('ResourceReview as rr')
    .innerJoin('Model as m', 'm.id', 'rr.modelId')
    .innerJoin('User as u', 'u.id', 'm.userId')
    .select([
      'rr.id',
      'rr.createdAt',
      'rr.rating',
      'rr.modelId',
      'rr.tosViolation',
      'rr.exclude',
      'u.username as modelCreator',
    ])
    .where('rr.userId', '=', userId)
    .orderBy('rr.createdAt', 'desc')
    .limit(limit)
    .execute();
}

// Reviews RECEIVED on this user's models (Retool's ReceivedReviews, behind the tab that was never
// ported). A different question from reviews written: a creator drawing a burst of 1★ reviews, or one
// whose models are reviewed only by a handful of accounts, is what this surfaces.
export type ReceivedReview = {
  id: number;
  createdAt: Date;
  rating: number | null;
  exclude: boolean | null;
  details: string | null;
  modelId: number | null;
  modelName: string | null;
  reviewerId: number;
  reviewer: string | null;
};

export async function getReceivedReviews(userId: number, limit = 25): Promise<ReceivedReview[]> {
  return dbRead
    .selectFrom('ResourceReview as rr')
    .innerJoin('Model as m', 'm.id', 'rr.modelId')
    .innerJoin('User as u', 'u.id', 'rr.userId')
    .select([
      'rr.id',
      'rr.createdAt',
      'rr.rating',
      'rr.exclude',
      'rr.details',
      'rr.modelId',
      'm.name as modelName',
      'rr.userId as reviewerId',
      'u.username as reviewer',
    ])
    .where('m.userId', '=', userId)
    // Retool showed a creator's own reviews of their own models among the reviews they received; they
    // are self-authored and carry no signal about how the model was received.
    .where('rr.userId', '!=', userId)
    .orderBy('rr.createdAt', 'desc')
    .limit(limit)
    .execute();
}

// BOUNTIES (Retool's BountyList / BountyEntryList — a whole tab pair that was never ported). Both
// sides matter: bounties this user funded, and entries they submitted to others'.
export type UserBounty = {
  id: number;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  complete: boolean;
  /** Summed across benefactors — Retool's join emitted one row per benefactor, so a bounty with three
   *  backers appeared three times, each showing only that backer's share. */
  unitAmount: number;
};

export async function getBounties(userId: number, limit = 25): Promise<UserBounty[]> {
  const rows = await dbRead
    .selectFrom('Bounty as b')
    .leftJoin('BountyBenefactor as bb', 'bb.bountyId', 'b.id')
    .select((eb) => [
      'b.id',
      'b.name',
      'b.createdAt',
      'b.expiresAt',
      'b.complete',
      eb.fn.coalesce(eb.fn.sum<string>('bb.unitAmount'), sql<string>`0`).as('unitAmount'),
    ])
    .where('b.userId', '=', userId)
    .groupBy(['b.id', 'b.name', 'b.createdAt', 'b.expiresAt', 'b.complete'])
    .orderBy('b.createdAt', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, unitAmount: Number(r.unitAmount) }));
}

export type UserBountyEntry = {
  id: number;
  bountyId: number;
  bountyName: string;
  createdAt: Date;
  description: string | null;
};

export async function getBountyEntries(userId: number, limit = 25): Promise<UserBountyEntry[]> {
  return dbRead
    .selectFrom('BountyEntry as be')
    .innerJoin('Bounty as b', 'b.id', 'be.bountyId')
    .select(['be.id', 'be.bountyId', 'b.name as bountyName', 'be.createdAt', 'be.description'])
    .where('be.userId', '=', userId)
    .orderBy('be.createdAt', 'desc')
    .limit(limit)
    .execute();
}

export type UserComment = {
  id: number;
  createdAt: Date;
  content: string;
  nsfw: boolean | null;
  tosViolation: boolean | null;
  modelId: number | null;
};

export async function getComments(userId: number, limit = 25): Promise<UserComment[]> {
  return dbRead
    .selectFrom('Comment')
    .select(['id', 'createdAt', 'content', 'nsfw', 'tosViolation', 'modelId'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .execute();
}

// Retool's segmentedControl1 split comments into "Model Comments" (`Comment`) and "Other Comments"
// (`CommentV2` — image, article, bounty and post threads). Only the first was ported; this is the
// other half, and it is the larger table on most accounts.
export type UserCommentV2 = {
  id: number;
  createdAt: Date;
  content: string;
  tosViolation: boolean | null;
  threadId: number;
};

export async function getCommentsV2(userId: number, limit = 25): Promise<UserCommentV2[]> {
  return dbRead
    .selectFrom('CommentV2')
    .select(['id', 'createdAt', 'content', 'tosViolation', 'threadId'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .execute();
}

// REACTIONS GIVEN, grouped by the creator whose images were reacted to (Retool's ReactionsGrouped).
// The concentration is the signal — a normal account spreads reactions over hundreds of creators, a
// vote-ring account puts most of them on one.
//
// `ReactionsAll` (every raw reaction row) is not ported: it is unbounded, and the top of this list
// answers the question the raw rows were being scanned to answer.
//
// Reads a 744M-row table, so it stays off the page load. Bounded by the ImageReaction_userId index:
// ~47ms at 49K reactions, ~605ms for the heaviest account on the site (6M).
// `UserStat.reactionCountAllTime` is NOT this number — it counts reactions the user RECEIVED (measured:
// 51,775 received against 312 given for the same account). The window function totals every group
// before LIMIT trims them, so the total costs no extra round trip and stays honest.
export type ReactionTarget = { userId: number; username: string | null; count: number };
export type ReactionSummary = { total: number; creators: number; targets: ReactionTarget[] };

export async function getReactionTargets(userId: number, limit = 10): Promise<ReactionSummary> {
  const rows = await dbRead
    .selectFrom('ImageReaction as ir')
    .innerJoin('Image as i', 'i.id', 'ir.imageId')
    .leftJoin('User as u', 'u.id', 'i.userId')
    .select((eb) => [
      'i.userId',
      'u.username',
      eb.fn.countAll<string>().as('count'),
      sql<string>`sum(count(*)) over ()`.as('total'),
      sql<string>`count(*) over ()`.as('creators'),
    ])
    .where('ir.userId', '=', userId)
    .groupBy(['i.userId', 'u.username'])
    .orderBy('count', 'desc')
    .limit(limit)
    .execute();

  return {
    total: Number(rows[0]?.total ?? 0),
    creators: Number(rows[0]?.creators ?? 0),
    targets: rows.map((r) => ({ userId: r.userId, username: r.username, count: Number(r.count) })),
  };
}

// COSMETICS — read-only. Retool's RemoveCosmetics is deliberately not ported (destructive, and the
// main app's equivalent also refreshes entity caches and search indexes).
export type UserCosmeticRow = {
  /** `${cosmeticId}:${claimKey}` — UserCosmetic's key is (userId, cosmeticId, claimKey), so the
   *  cosmetic id alone is not unique per user and collides for repeat claims. */
  key: string;
  name: string;
  type: string;
  equipped: boolean;
  obtainedAt: Date | null;
};

export async function getCosmetics(userId: number, limit = 50): Promise<UserCosmeticRow[]> {
  const rows = await dbRead
    .selectFrom('UserCosmetic as uc')
    .innerJoin('Cosmetic as c', 'c.id', 'uc.cosmeticId')
    // `equippedAt` is the canonical "is this equipped" test, matching the main app. `equippedToId` is
    // the entity it is attached to, and is NULL for profile-level cosmetics that ARE equipped.
    .select(['uc.cosmeticId', 'uc.claimKey', 'c.name', 'c.type', 'uc.equippedAt', 'uc.obtainedAt'])
    .where('uc.userId', '=', userId)
    .orderBy('uc.obtainedAt', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    key: `${r.cosmeticId}:${r.claimKey}`,
    name: r.name,
    type: String(r.type),
    equipped: r.equippedAt !== null,
    obtainedAt: r.obtainedAt,
  }));
}

// BUZZ balances (Retool's GetAccountBuzz + GetGenBuzz + GetGreenBuzz — three queries, three colours;
// only yellow had been ported). An external HTTP call, so it never rides the page load. Best-effort:
// Buzz being down should not blank the rest of the panel.
export type UserBuzz = {
  balance: number;
  lifetimeBalance: number;
  /** Blue (generation) and green. Null when that account could not be read. */
  blue: number | null;
  green: number | null;
} | null;

export async function getBuzzBalance(userId: number): Promise<UserBuzz> {
  try {
    const account = await getBuzz().getAccount(userId);
    // Colour balances are a second call and a softer failure — yellow is the one a moderator acts on,
    // so it must not be lost when the multi-account read fails.
    let blue: number | null = null;
    let green: number | null = null;
    try {
      const accounts = await getBuzz().getUserAccounts(userId, ['blue', 'green']);
      blue = accounts.Generation ?? accounts.blue ?? null;
      green = accounts.Green ?? accounts.green ?? null;
    } catch (e) {
      console.error('[user-lookup] buzz colour balances unavailable', e);
    }
    return {
      balance: account.balance,
      lifetimeBalance: account.lifetimeBalance,
      blue,
      green,
    };
  } catch (e) {
    console.error('[user-lookup] buzz balance unavailable', e);
    return null;
  }
}

// NOTIFICATIONS the user has been sent (Retool's GetNotifications / ViewNotifications, which read the
// notifications database directly). This app has no connection to it, so it goes through the same
// service client the rest of the monorepo uses.
//
// Best-effort: the notifications app being down should not blank the panel it shares.
export type UserNotification = {
  id: number;
  type: string;
  category: string;
  createdAt: Date;
  read: boolean;
};

export async function getUserNotifications(
  userId: number,
  limit = 25
): Promise<UserNotification[] | null> {
  try {
    const rows = await getNotifications().queryNotifications({ userId, limit });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      category: r.category,
      createdAt: r.createdAt,
      read: r.read,
    }));
  } catch (e) {
    console.error('[user-lookup] notifications unavailable', e);
    return null;
  }
}

// GENERATIONS OF THIS USER'S RESOURCES (Retool's GetModelVersions + GensPerResource, run as two steps).
// The reward-farming signal: a creator whose resources are generated with almost exclusively by a
// handful of accounts, or whose counts spike, is what this surfaces.
export type ResourceGeneration = {
  modelVersionId: number;
  modelId: number;
  modelName: string;
  count: number;
};

export async function getResourceGenerations(
  userId: number,
  days = 30,
  limit = 15
): Promise<ResourceGeneration[]> {
  const versions = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(['mv.id as modelVersionId', 'm.id as modelId', 'm.name as modelName'])
    .where('m.userId', '=', userId)
    // Bounded because the id list is interpolated into ClickHouse unescaped and a prolific creator has
    // thousands of versions. Newest first — those are the ones a farming check is about.
    .orderBy('mv.id', 'desc')
    .limit(500)
    .execute();
  if (!versions.length) return [];

  const ids = versions.map((v) => v.modelVersionId).join(', ');
  const rows = await getClickhouse().$query<{ modelVersionId: string; count: string }>(`
    SELECT modelVersionId, sum(count) AS count
    FROM daily_resource_generation_counts
    WHERE createdDate >= subtractDays(toStartOfDay(now()), ${days})
      AND modelVersionId IN (${ids})
    GROUP BY modelVersionId
    ORDER BY count DESC
    LIMIT ${limit}
  `);

  const byVersion = new Map(versions.map((v) => [v.modelVersionId, v]));
  return rows.flatMap((r) => {
    const v = byVersion.get(Number(r.modelVersionId));
    return v ? [{ ...v, count: Number(r.count) }] : [];
  });
}

// MODERATOR ACTIVITY (ticket §1.2e — "what was done to this account, and who did it")
//
// ModActivity keys content actions by CONTENT id, not user id, so there are two shapes: rows that point
// at the user directly (`user`, `impersonate`), and rows that point at something they own, reached by
// joining their content. Both use the (entityType, entityId, createdAt) index added when the table was
// made append-only.
//
// History only accrues from that migration forward — earlier rows were deduped in place by the unique
// index it dropped, so older accounts will look sparser than they were.
export type ModActivityRow = {
  id: number;
  activity: string;
  entityType: string;
  entityId: number | null;
  createdAt: Date;
  moderatorId: number | null;
  moderatorUsername: string | null;
};

const ACTIVITY_CONTENT = [
  ['image', 'Image'],
  ['model', 'Model'],
  ['article', 'Article'],
] as const;

export async function getModActivity(userId: number, limit = 40): Promise<ModActivityRow[]> {
  const select = [
    // `id` is selected purely so the UI has a stable key — ModActivity is append-only now, so two rows
    // can share (createdAt, activity, entityId) and a composite key would collide.
    'ma.id',
    'ma.activity',
    'ma.entityType',
    'ma.entityId',
    'ma.createdAt',
    'ma.userId',
  ] as const;

  const direct = dbRead
    .selectFrom('ModActivity as ma')
    .select(select)
    .where('ma.entityType', 'in', ['user', 'impersonate'])
    .where('ma.entityId', '=', userId)
    .orderBy('ma.createdAt', 'desc')
    .limit(limit)
    .execute();

  const viaContent = ACTIVITY_CONTENT.map(([entityType, table]) =>
    dbRead
      .selectFrom('ModActivity as ma')
      .innerJoin(`${table} as c` as 'Image as c', 'c.id', 'ma.entityId')
      .select(select)
      .where('ma.entityType', '=', entityType)
      .where('c.userId', '=', userId)
      .orderBy('ma.createdAt', 'desc')
      .limit(limit)
      .execute()
  );

  const rows = (await Promise.all([direct, ...viaContent]))
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  const byId = await usersByIds(rows.map((r) => r.userId ?? 0));

  return rows.map((r) => ({
    id: r.id,
    activity: r.activity,
    entityType: r.entityType ?? '',
    entityId: r.entityId,
    createdAt: r.createdAt,
    moderatorId: r.userId,
    moderatorUsername: r.userId ? (byId.get(r.userId)?.username ?? null) : null,
  }));
}

// TRAINING RUNS (Retool's NewSubmittedTrainsBrett). Retool selected `ModelFile.*` plus ~20 training
// hyperparameters — batch size, LR schedule, network dim. Those are for debugging a failed train, not for
// moderating an account, so what is ported is what a moderator acts on: what was trained, from what, how
// far it got, how much it cost and whether it is public.
export type TrainingRun = {
  modelVersionId: number;
  modelId: number;
  name: string | null;
  baseModel: string | null;
  trainingType: string | null;
  status: string | null;
  numImages: number | null;
  sharedDataset: boolean;
  currentEpoch: number | null;
  maxEpochs: number | null;
  buzzCost: number | null;
  startedAt: string | null;
  completedAt: string | null;
};

export async function getTrainingRuns(
  userId: number,
  limit = 25
): Promise<{ runs: TrainingRun[]; truncated: boolean }> {
  const rows = await dbRead
    .selectFrom('Model as m')
    .innerJoin('ModelVersion as mv', 'mv.modelId', 'm.id')
    // Retool filtered `type = 'Training Data' OR type IS NULL` in the WHERE, which drops a version whose
    // only files are of another type. Moving it into the join keeps the run visible with no file.
    //
    // DISTINCT ON because the join is one-to-many: 287 trained versions carry more than one Training
    // Data file (max 7). Retool got away with it by presenting a FILE table; this presents RUNS, so
    // without the dedupe one run rendered up to seven times, produced a duplicate {#each} key, and ate
    // the row budget — 25 rows could be 19 distinct runs.
    .distinctOn('mv.id')
    .leftJoin('ModelFile as mf', (join) =>
      join.onRef('mf.modelVersionId', '=', 'mv.id').on('mf.type', '=', 'Training Data')
    )
    .select([
      'mv.id as modelVersionId',
      'm.id as modelId',
      'mv.name',
      'mv.trainingStatus',
      sql<string | null>`mv."trainingDetails"::json ->> 'baseModel'`.as('baseModel'),
      sql<string | null>`mv."trainingDetails"::json ->> 'type'`.as('trainingType'),
      sql<
        number | null
      >`nullif(mv."trainingDetails"::json -> 'params' ->> 'maxTrainEpochs', '')::int`.as('maxEpochs'),
      sql<number | null>`nullif(mf.metadata::json ->> 'numImages', '')::int`.as('numImages'),
      sql<string | null>`mf.metadata::json ->> 'shareDataset'`.as('sharedDataset'),
      sql<
        number | null
      >`json_array_length(mf.metadata::json -> 'trainingResults' -> 'epochs')`.as('currentEpoch'),
      // Cost is the sum of the `credit` entries in transactionData; older rows carry only a
      // transactionId with no amount, and those read as unknown rather than zero.
      sql<number | null>`(
        SELECT sum((x.val ->> 'amount')::int)
        FROM jsonb_array_elements(mf.metadata::jsonb -> 'trainingResults' -> 'transactionData') AS x(val)
        WHERE x.val ->> 'type' = 'credit'
      )`.as('buzzCost'),
      sql<string | null>`coalesce(
        mf.metadata::json -> 'trainingResults' ->> 'startedAt',
        mf.metadata::json -> 'trainingResults' ->> 'start_time'
      )`.as('startedAt'),
      sql<string | null>`coalesce(
        mf.metadata::json -> 'trainingResults' ->> 'completedAt',
        mf.metadata::json -> 'trainingResults' ->> 'end_time'
      )`.as('completedAt'),
    ])
    .where('mv.uploadType', '=', 'Trained')
    .where('m.userId', '=', userId)
    // DISTINCT ON fixes the leading ORDER BY; `mf.id desc` picks the newest file per version.
    .orderBy('mv.id', 'desc')
    .orderBy('mf.id', 'desc')
    .limit(limit + 1)
    .execute();

  // 2,248 users have more than 25 trained versions. Capping without saying so let the panel offer
  // "Show all 25" on an account with hundreds — the opposite of what a mass-production check needs.
  const truncated = rows.length > limit;
  const runs = rows.slice(0, limit).map((r) => ({
    modelVersionId: r.modelVersionId,
    modelId: r.modelId,
    name: r.name,
    baseModel: r.baseModel,
    trainingType: r.trainingType,
    status: r.trainingStatus === null ? null : String(r.trainingStatus),
    numImages: r.numImages,
    sharedDataset: r.sharedDataset === 'true',
    currentEpoch: r.currentEpoch,
    maxEpochs: r.maxEpochs,
    buzzCost: r.buzzCost === null ? null : Number(r.buzzCost),
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }));

  return { runs, truncated };
}

// BUZZ HISTORY (Retool's Receipts + Payments, which were two queries and two tables on the page).
// Merged: a moderator wants this account's Buzz movement in one timeline, and the two queries differ
// only in which side of the transaction the account is on.
//
// `buzzTransactions` is 1.5B rows partitioned by month, so the window bound prunes partitions as well as
// rows — Retool bounded it too (`buzzDateTime`). Even bounded to 90 days this measures ~2.5s: the table
// sorts by date ASCENDING and this reads it descending. Hence its own endpoint.
const BUZZ_COLORS: Record<string, string> = {
  user: 'Yellow',
  yellow: 'Yellow',
  generation: 'Blue',
  blue: 'Blue',
  green: 'Green',
};

/** Account types whose id is a real `User.id`. Everything else transacts in the same integer space
 *  without being a user — see the collision note in `getBuzzHistory`. */
const USER_ACCOUNT_TYPES = new Set(['user', 'yellow', 'generation', 'blue', 'green']);

const counterpartyLabel = (accountType: string, id: number) =>
  id === 0 ? 'Civitai' : accountType || `account ${id}`;

export async function getBuzzHistory(
  userId: number,
  days = 90,
  limit = 50
): Promise<{ transactions: BuzzTransaction[]; days: number; truncated: boolean }> {
  const rows = await getClickhouse().$query<{
    transactionId: string;
    date: string;
    direction: string;
    amount: string;
    accountType: string;
    type: string;
    description: string;
    counterpartyId: string;
    counterpartyType: string;
  }>(`
    SELECT
      transactionId,
      date,
      if(toAccountId = ${userId}, 'in', 'out') AS direction,
      amount,
      -- OUR side, not the counterparty's. Which colour of Buzz this account received or spent is the
      -- point; the other side's type is a different fact. Reading the wrong side mislabels the most
      -- common row on the table (a yellow-to-blue reward reads as Yellow when Blue was received), and
      -- Yellow vs Blue is exactly the distinction a farming investigation turns on. Matches the main
      -- app's buzz.service.ts.
      if(toAccountId = ${userId}, toAccountType, fromAccountType) AS accountType,
      if(toAccountId = ${userId}, fromAccountType, toAccountType) AS counterpartyType,
      type,
      description,
      if(toAccountId = ${userId}, fromAccountId, toAccountId) AS counterpartyId
    FROM default.buzzTransactions
    WHERE date > now() - INTERVAL ${days} DAY
      AND (fromAccountId = ${userId} OR toAccountId = ${userId})
    ORDER BY date DESC
    LIMIT ${limit + 1}
  `);

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  // A counterparty id is only a USER id when the counterparty is a user-held account. Other account
  // types reuse the same integer space: `creatorProgramBank` transacts as account 202607/202608, and
  // those are real, unrelated user ids (`vvendeta`, `sirnofish`) — resolving them would name an innocent
  // creator as the counterparty of every Creator Program transfer.
  const resolvable = page.filter((r) => USER_ACCOUNT_TYPES.has(r.counterpartyType));
  const ids = [...new Set(resolvable.map((r) => Number(r.counterpartyId)))].filter((id) => id > 0);
  const byId = await usersByIds(ids);

  return {
    days,
    truncated,
    transactions: page.map((r) => {
      const id = Number(r.counterpartyId);
      const isUser = USER_ACCOUNT_TYPES.has(r.counterpartyType) && id > 0;
      return {
        transactionId: r.transactionId,
        // ClickHouse returns `YYYY-MM-DD HH:MM:SS` with no zone; `new Date()` would read that as LOCAL
        // time and shift every row by the viewer's offset, putting it on a different day from the IP and
        // prompt timestamps it is meant to line up with.
        date: clickhouseDate(r.date),
        direction: r.direction === 'in' ? 'in' : 'out',
        amount: Number(r.amount),
        color: BUZZ_COLORS[r.accountType] ?? r.accountType,
        type: r.type,
        description: r.description,
        counterpartyId: id,
        counterpartyName: isUser ? (byId.get(id)?.username ?? null) : null,
        counterpartyLabel: isUser ? null : counterpartyLabel(r.counterpartyType, id),
      };
    }),
  };
}
