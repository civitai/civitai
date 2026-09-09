import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { utcMs } from '$lib/format';
import { getBuzz } from './buzz';
import { getNotifications } from './notifications';
import { getModeratorDb } from './moderator-db';
import { usersByIds } from './users.service';
import { RATING_ACTIVITIES } from '$lib/mod-activity';
import { MIN_FLAGGED } from '$lib/reactions';
import type { BuzzTransaction } from '../../routes/retool/user-lookup/buzz-history';

// Everything behind `/api/user-account`, plus the two endpoints that exist only because their query is
// slow enough to need its own: `/api/user-mod-activity` and `/api/user-buzz-history`.
//
// One file per endpoint is the rule for this page's services — see user-signals.service.ts.

// Every list here is server-limited, and a limit rendered as a total is a lie the UI cannot detect:
// "Model comments (25)" on an account with 4,000. Fetching one more row than asked for is how a caller
// learns the difference — `getTrainingRuns` already did this and the rest did not.
export type Capped<T> = { items: T[]; truncated: boolean };

const capped = <T>(rows: T[], limit: number): Capped<T> => ({
  items: rows.slice(0, limit),
  truncated: rows.length > limit,
});

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
  nsfw: boolean | null;
  /** The review TEXT. Retool's pane searched it, and deleting a review on rating and date alone is
   *  deciding without reading it. */
  details: string | null;
  modelCreator: string | null;
  imageCount: number;
};

export async function getReviews(userId: number, limit = 100): Promise<Capped<UserReview>> {
  // Retool's SubmittedReviewImageCount. This is the body of the `ResourceReviewHelper` VIEW, inlined and
  // correlated to the row — NEVER join the view itself. It groups over all 71M reviews, and the qual does
  // not push through, so both a join and a keyed `IN (…)` lookup run past 60s for a user with 51 reviews.
  // (The main app hit the same wall and commented its copy out: resourceReview.service.ts.) Correlated
  // per returned row: 0.9s.
  return dbRead
    .selectFrom('ResourceReview as rr')
    .innerJoin('Model as m', 'm.id', 'rr.modelId')
    .innerJoin('User as u', 'u.id', 'm.userId')
    .select((eb) =>
      eb
        .selectFrom('ImageResourceNew as ir')
        .innerJoin('Image as i', (join) =>
          join.onRef('i.id', '=', 'ir.imageId').onRef('i.userId', '=', 'rr.userId')
        )
        .select((agg) => agg.fn.count('i.id').distinct().as('count'))
        .whereRef('ir.modelVersionId', '=', 'rr.modelVersionId')
        .as('imageCount')
    )
    .select([
      'rr.id',
      'rr.createdAt',
      'rr.rating',
      'rr.modelId',
      'rr.tosViolation',
      'rr.exclude',
      'rr.nsfw',
      'rr.details',
      'u.username as modelCreator',
    ])
    .where('rr.userId', '=', userId)
    .orderBy('rr.createdAt', 'desc')
    .limit(limit + 1)
    .execute()
    .then((rows) =>
      capped(
        rows.map((row) => ({ ...row, imageCount: Number(row.imageCount ?? 0) })),
        limit
      )
    );
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

export async function getReceivedReviews(
  userId: number,
  limit = 100
): Promise<Capped<ReceivedReview>> {
  return (
    dbRead
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
      .limit(limit + 1)
      .execute()
      .then((rows) => capped(rows, limit))
  );
}

// BOUNTIES (Retool's BountyList / BountyEntryList — a whole tab pair that was never ported). Both
// sides matter: bounties this user funded, and entries they submitted to others'.
export type UserBounty = {
  id: number;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  complete: boolean;
  type: string;
  description: string | null;
  /** Summed across benefactors — Retool's join emitted one row per benefactor, so a bounty with three
   *  backers appeared three times, each showing only that backer's share. */
  unitAmount: number;
};

export async function getBounties(userId: number, limit = 100): Promise<Capped<UserBounty>> {
  const rows = await dbRead
    .selectFrom('Bounty as b')
    .leftJoin('BountyBenefactor as bb', 'bb.bountyId', 'b.id')
    .select((eb) => [
      'b.id',
      'b.name',
      'b.createdAt',
      'b.expiresAt',
      'b.complete',
      'b.type',
      'b.description',
      eb.fn.coalesce(eb.fn.sum<string>('bb.unitAmount'), sql<string>`0`).as('unitAmount'),
    ])
    .where('b.userId', '=', userId)
    .groupBy([
      'b.id',
      'b.name',
      'b.createdAt',
      'b.expiresAt',
      'b.complete',
      'b.type',
      'b.description',
    ])
    .orderBy('b.createdAt', 'desc')
    .limit(limit + 1)
    .execute();
  return capped(
    rows.map((r) => ({ ...r, unitAmount: Number(r.unitAmount) })),
    limit
  );
}

export type UserBountyEntry = {
  id: number;
  bountyId: number;
  bountyName: string;
  createdAt: Date;
  description: string | null;
};

export async function getBountyEntries(
  userId: number,
  limit = 25
): Promise<Capped<UserBountyEntry>> {
  return dbRead
    .selectFrom('BountyEntry as be')
    .innerJoin('Bounty as b', 'b.id', 'be.bountyId')
    .select(['be.id', 'be.bountyId', 'b.name as bountyName', 'be.createdAt', 'be.description'])
    .where('be.userId', '=', userId)
    .orderBy('be.createdAt', 'desc')
    .limit(limit + 1)
    .execute()
    .then((rows) => capped(rows, limit));
}

export type UserComment = {
  id: number;
  createdAt: Date;
  content: string;
  nsfw: boolean | null;
  tosViolation: boolean | null;
  modelId: number | null;
};

export async function getComments(userId: number, limit = 25): Promise<Capped<UserComment>> {
  return dbRead
    .selectFrom('Comment')
    .select(['id', 'createdAt', 'content', 'nsfw', 'tosViolation', 'modelId'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .execute()
    .then((rows) => capped(rows, limit));
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
  /** What the comment is ON — resolved through the thread, and through its root thread for replies. */
  entityType: string | null;
  entityId: number | null;
};

// `Thread` carries one nullable FK per commentable type, so resolving what a comment is attached to is
// a coalesce across all of them — no builder equivalent. A reply's own thread points at the parent
// comment, so the ROOT thread is what identifies the image or model it ultimately hangs off; Retool's
// CommentsWithLinks coalesced root first for exactly that reason.
//
// (Its name promises a link filter that its SQL does not contain — the filtering was done in the
// browser. What the query is actually for is this resolution, so that is what is ported.)
const THREAD_TARGETS = [
  'imageId',
  'modelId',
  'postId',
  'articleId',
  'bountyId',
  'bountyEntryId',
  'reviewId',
  'questionId',
  'answerId',
] as const;

const threadEntityId = sql<number | null>`coalesce(${sql.join(
  THREAD_TARGETS.flatMap((c) => [sql`root.${sql.ref(c)}`, sql`t.${sql.ref(c)}`]),
  sql`, `
)})`;

const threadEntityType = sql<string | null>`case ${sql.join(
  THREAD_TARGETS.map(
    (c) =>
      sql`when coalesce(root.${sql.ref(c)}, t.${sql.ref(c)}) is not null then ${sql.lit(
        c.replace(/Id$/, '')
      )}`
  ),
  sql` `
)} end`;

export async function getCommentsV2(userId: number, limit = 25): Promise<Capped<UserCommentV2>> {
  return dbRead
    .selectFrom('CommentV2 as c')
    .leftJoin('Thread as t', 't.id', 'c.threadId')
    .leftJoin('Thread as root', 'root.id', 't.rootThreadId')
    .select([
      'c.id',
      'c.createdAt',
      'c.content',
      'c.tosViolation',
      'c.threadId',
      threadEntityId.as('entityId'),
      threadEntityType.as('entityType'),
    ])
    .where('c.userId', '=', userId)
    .orderBy('c.createdAt', 'desc')
    .limit(limit + 1)
    .execute()
    .then((rows) => capped(rows, limit));
}

// REACTIONS GIVEN, grouped by the creator whose images were reacted to (Retool's ReactionsGrouped).
//
// Two lists in one query: the top `limit` by volume, plus up to `flagLimit` whose mix is majority
// Laugh/Cry/Dislike over `MIN_FLAGGED`. Volume alone misses harassment — on the account this was
// built for, the reported target sat at 64 of 21,840 reactions, outside the top ten.
//
// A per-minute burst count was tried and dropped: it does not discriminate (152 of 3,307 targets had
// a 20+/minute burst — what thumbing through a gallery looks like) and cost 22s against 4.4s.
// `ClickHouse.reactions.time` is NOT an alternative source for cadence: it is batch-flushed, so 43
// reactions 1.4s apart here share five timestamps there and read as a bot.
//
// `ReactionsAll` (every raw reaction row) is not ported: unbounded, and the top of this list answers
// what the raw rows were being scanned for.
//
// Reads a 744M-row table, so it stays off the page load — ~150ms at 22K reactions, 4.4s on the
// heaviest account sampled, bounded by the ImageReaction_userId index; the FILTERs and min/max ride
// the scan the count already pays for. `UserStat.reactionCountAllTime` is NOT this number: it counts
// reactions RECEIVED (51,775 received against 312 given, same account). The window functions total
// every group before the outer WHERE trims them, so the totals cost no extra round trip.

export type ReactionTarget = {
  userId: number;
  username: string | null;
  count: number;
  like: number;
  heart: number;
  laugh: number;
  cry: number;
  dislike: number;
  first: Date;
  last: Date;
  /** Laugh+Cry+Dislike as a fraction of `count`, 0..1. Computed here because the ranking needs it,
   *  and returned so the panel cannot arrive at a second answer to "which reactions are negative". */
  negativeShare: number;
  /** Majority Laugh/Cry/Dislike over `MIN_FLAGGED`. The PATTERN, not how the row was selected — a
   *  creator in the volume top-N carrying the same mix is flagged too. */
  flagged: boolean;
};
export type ReactionSummary = {
  total: number;
  creators: number;
  targets: ReactionTarget[];
  /** Every creator matching `flagged`, not just the `flagLimit` returned — rendering the cap as the
   *  total would read as the whole victim list. */
  flaggedTotal: number;
};

type ReactionRow = ReactionTarget & { total: number; creators: number; flaggedTotal: number };

// flagLimit is generous because on a harassment account this half of the list IS the finding: the
// example that prompted it had 22 qualifying creators, the reported one fifteenth by share.
export async function getReactionTargets(
  userId: number,
  limit = 10,
  flagLimit = 20
): Promise<ReactionSummary> {
  const { rows } = await sql<ReactionRow>`
    WITH agg AS (
      SELECT i."userId" AS "targetId",
        count(*)::int AS count,
        count(*) FILTER (WHERE ir.reaction = 'Like')::int AS "like",
        count(*) FILTER (WHERE ir.reaction = 'Heart')::int AS heart,
        count(*) FILTER (WHERE ir.reaction = 'Laugh')::int AS laugh,
        count(*) FILTER (WHERE ir.reaction = 'Cry')::int AS cry,
        count(*) FILTER (WHERE ir.reaction = 'Dislike')::int AS dislike,
        min(ir."createdAt") AS first,
        max(ir."createdAt") AS last,
        (sum(count(*)) OVER ())::int AS total,
        (count(*) OVER ())::int AS creators
      FROM "ImageReaction" ir
      JOIN "Image" i ON i.id = ir."imageId"
      WHERE ir."userId" = ${userId}
      GROUP BY 1
    ), scored AS (
      SELECT a.*,
        (a.count >= ${MIN_FLAGGED} AND (a.laugh + a.cry + a.dislike) * 2 > a.count) AS flagged,
        ((a.laugh + a.cry + a.dislike)::float8 / a.count) AS "negativeShare"
      FROM agg a
    ), ranked AS (
      SELECT s.*,
        -- PARTITION BY flagged keeps the mix ranking inside the qualifying set; over every group,
        -- browse-heavy creators with a few hundred incidental Laughs take the slots and the
        -- 38-of-40 target never appears. Share, not absolute, for the same reason: 100% of 25
        -- outranks 55% of 400.
        (row_number() OVER (
           PARTITION BY s.flagged
           ORDER BY s."negativeShare" DESC, s.count DESC, s."targetId"
         ))::int AS by_negative,
        -- Ties are broken on targetId so a reload cannot silently swap which creators are shown.
        (row_number() OVER (ORDER BY s.count DESC, s."targetId"))::int AS by_count,
        (count(*) FILTER (WHERE s.flagged) OVER ())::int AS "flaggedTotal"
      FROM scored s
    )
    SELECT k."targetId" AS "userId", u.username, k.count, k."like", k.heart, k.laugh, k.cry,
           k.dislike, k.first, k.last, k."negativeShare", k.total, k.creators, k.flagged,
           k."flaggedTotal"
    FROM ranked k
    LEFT JOIN "User" u ON u.id = k."targetId"
    WHERE k.by_count <= ${limit}
       OR (k.flagged AND k.by_negative <= ${flagLimit})
    ORDER BY k.count DESC
  `.execute(dbRead);

  return {
    total: rows[0]?.total ?? 0,
    creators: rows[0]?.creators ?? 0,
    flaggedTotal: rows[0]?.flaggedTotal ?? 0,
    targets: rows.map(({ total: _t, creators: _c, flaggedTotal: _f, ...target }) => target),
  };
}

export type UserCosmeticRow = {
  /** `${cosmeticId}:${claimKey}` — UserCosmetic's key is (userId, cosmeticId, claimKey), so the
   *  cosmetic id alone is not unique per user and collides for repeat claims. */
  key: string;
  /** Both halves of the key are carried separately: claimKey can itself contain a colon (it holds the
   *  buzzTransactionId on a shop grant), so removal must not re-split `key`. */
  cosmeticId: number;
  claimKey: string;
  name: string;
  type: string;
  equipped: boolean;
  obtainedAt: Date | null;
};

export async function getCosmetics(userId: number, limit = 50): Promise<Capped<UserCosmeticRow>> {
  const rows = await dbRead
    .selectFrom('UserCosmetic as uc')
    .innerJoin('Cosmetic as c', 'c.id', 'uc.cosmeticId')
    // `equippedAt` is the canonical "is this equipped" test, matching the main app. `equippedToId` is
    // the entity it is attached to, and is NULL for profile-level cosmetics that ARE equipped.
    .select(['uc.cosmeticId', 'uc.claimKey', 'c.name', 'c.type', 'uc.equippedAt', 'uc.obtainedAt'])
    .where('uc.userId', '=', userId)
    .orderBy('uc.obtainedAt', 'desc')
    .limit(limit + 1)
    .execute();
  return capped(
    rows.map((r) => ({
      key: `${r.cosmeticId}:${r.claimKey}`,
      cosmeticId: r.cosmeticId,
      claimKey: r.claimKey,
      name: r.name,
      type: String(r.type),
      equipped: r.equippedAt !== null,
      obtainedAt: r.obtainedAt,
    })),
    limit
  );
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
  /** Lifetime per colour. Retool showed all three; `getUserAccounts` returns balances only, so these
   *  come from the per-type account read. */
  blueLifetime: number | null;
  greenLifetime: number | null;
} | null;

export async function getBuzzBalance(userId: number): Promise<UserBuzz> {
  try {
    // Typed read: untyped `/account/{id}` returns Yellow + Blue summed, overstating Yellow by the
    // user's generation balance.
    const account = await getBuzz().getUserBuzzByAccountType(userId, 'yellow');
    // Colour balances are a second call and a softer failure — yellow is the one a moderator acts on,
    // so it must not be lost when the multi-account read fails.
    let blue: number | null = null;
    let green: number | null = null;
    let blueLifetime: number | null = null;
    let greenLifetime: number | null = null;
    try {
      // Per-type reads rather than `getUserAccounts`, which returns balances only — Retool showed a
      // lifetime for every colour, and lifetime is what says whether a balance was earned or granted.
      const [blueAcct, greenAcct] = await Promise.all([
        getBuzz().getUserBuzzByAccountType(userId, 'blue'),
        getBuzz().getUserBuzzByAccountType(userId, 'green'),
      ]);
      blue = blueAcct?.balance ?? null;
      green = greenAcct?.balance ?? null;
      blueLifetime = blueAcct?.lifetimeBalance ?? null;
      greenLifetime = greenAcct?.lifetimeBalance ?? null;
    } catch (e) {
      console.error('[user-lookup] buzz colour balances unavailable', e);
    }
    return {
      balance: account.balance,
      lifetimeBalance: account.lifetimeBalance,
      blue,
      green,
      blueLifetime,
      greenLifetime,
    };
  } catch (e) {
    console.error('[user-lookup] buzz balance unavailable', e);
    return null;
  }
}

// COSMETIC SHOP PURCHASES (Retool's GetPurchases). Read from `UserCosmeticShopPurchases` rather than
// Retool's UserCosmetic→CosmeticShopItem join: that join matches any owned cosmetic that happens to
// have a shop listing, including ones granted rather than bought, and it cannot see `refunded` — so an
// already-refunded purchase looked identical to a live one, which is the one fact the refund flow
// needs.
export type ShopPurchase = {
  /** The purchase PK, and also the `claimKey` on the granted UserCosmetic row. */
  buzzTransactionId: string;
  cosmeticId: number | null;
  title: string;
  unitAmount: number;
  purchasedAt: Date;
  refunded: boolean;
};

export async function getShopPurchases(userId: number, limit = 50): Promise<Capped<ShopPurchase>> {
  return dbRead
    .selectFrom('UserCosmeticShopPurchases as p')
    .innerJoin('CosmeticShopItem as csi', 'csi.id', 'p.shopItemId')
    .select([
      'p.buzzTransactionId',
      'p.cosmeticId',
      'csi.title',
      'p.unitAmount',
      'p.purchasedAt',
      'p.refunded',
    ])
    .where('p.userId', '=', userId)
    .orderBy('p.purchasedAt', 'desc')
    .limit(limit + 1)
    .execute()
    .then((rows) => capped(rows, limit));
}

// Badges this user does NOT already hold (Retool's AvailableCosmeticList), for the grant picker.
export type AvailableCosmetic = { id: number; name: string };

// Every badge, not a page of them: there are ~723 and the picker is a search-in-place dropdown, so a
// limit silently makes the rest ungrantable. Capping at 200 ordered by id ASC hid every recent event
// badge — the exact case a moderator is asked about — behind a panel that then read "already holds
// every badge".
export async function getAvailableBadges(userId: number): Promise<AvailableCosmetic[]> {
  return (
    dbRead
      .selectFrom('Cosmetic as c')
      .select(['c.id', 'c.name'])
      .where('c.type', '=', 'Badge')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('UserCosmetic as uc')
              .select('uc.cosmeticId')
              .whereRef('uc.cosmeticId', '=', 'c.id')
              .where('uc.userId', '=', userId)
          )
        )
      )
      // Newest first — a moderator asked to grant a badge is almost always asked about a recent one.
      .orderBy('c.id', 'desc')
      .execute()
  );
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
  /** The panel exists to answer "I was never warned". Type and date do not answer it — the body does.
   *  Enriched by the monolith downstream, so what is here is the raw payload. */
  details: Record<string, unknown>;
};

export async function getUserNotifications(
  userId: number,
  limit = 25
): Promise<Capped<UserNotification> | null> {
  try {
    const rows = await getNotifications().queryNotifications({ userId, limit: limit + 1 });
    return capped(
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        category: r.category,
        createdAt: r.createdAt,
        read: r.read,
        details: r.details ?? {},
      })),
      limit
    );
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
  versionName: string | null;
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
    .select([
      'mv.id as modelVersionId',
      'm.id as modelId',
      'm.name as modelName',
      'mv.name as versionName',
    ])
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

/** `bucket` filters in SQL, never over the result: the queries below are each limited and then
 *  merged, so narrowing afterwards shrinks a window the discarded rows already truncated. */
export async function getModActivity(
  userId: number,
  limit = 40,
  bucket?: 'enforcement' | 'rating'
): Promise<ModActivityRow[]> {
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
    .$if(bucket === 'enforcement', (qb) => qb.where('ma.activity', 'not in', RATING_ACTIVITIES))
    .$if(bucket === 'rating', (qb) => qb.where('ma.activity', 'in', RATING_ACTIVITIES))
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
      .$if(bucket === 'enforcement', (qb) => qb.where('ma.activity', 'not in', RATING_ACTIVITIES))
      .$if(bucket === 'rating', (qb) => qb.where('ma.activity', 'in', RATING_ACTIVITIES))
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
    moderatorUsername: r.userId ? byId.get(r.userId)?.username ?? null : null,
  }));
}

// RETOOL-ERA MODERATION HISTORY (`ReToolActions`, 131k rows).
//
// This table has NO target column — the account is embedded in free text, e.g.
// `BAN: User tipclub5org1 12895025` or `Strike 1 on user 674388`. So the only way to attribute a row to
// an account is to match the id inside the string, with a word boundary so 1290051 does not also match
// 12900510. Format-agnostic on purpose: the phrasing varies by app and by year, and a prefix-based
// parser misses the older rows entirely.
//
// Seq scan by necessity (no index supports this, and one on a free-text column would not help a
// substring match) — measured at ~80ms over the full table, which is fine for a single lookup and is
// why it is a separate call rather than part of the account bundle.
//
// `User` is a Retool DISPLAY NAME, not a Civitai account, and only 5 of 37 map to one. It is shown
// as-is; a name -> userId mapping is a separate migration.
export type RetoolActivityRow = {
  id: number;
  at: Date;
  moderator: string | null;
  app: string | null;
  action: string | null;
};

export async function getRetoolActivity(userId: number, limit = 25): Promise<RetoolActivityRow[]> {
  const rows = await getModeratorDb()
    .selectFrom('ReToolActions')
    .select(['id', 'Event as at', 'User as moderator', 'App as app', 'ActionType as action'])
    // 🔴 The id must follow a SUBJECT LABEL, not merely be a standalone number. `ActionType` is free
    // text and 56% of rows carry more than one — `ToS 5 images from <id>`, `Strike 2 on user <id>`,
    // `Banned 47 accounts` — so a bare word-boundary match attributed every image COUNT and strike
    // number to whichever account shares that value. Measured against the moderator database: id 1
    // matched 22,130 unrelated rows, id 2 matched 7,289, id 5 matched 2,331 (2,204 of them
    // `ToS 5 images…`), and 101 accounts have an id under 100. Anchoring costs nothing — on real
    // 6-7 digit subject ids both forms return identical rows.
    //
    // `from ` requires digits immediately after, which is what excludes `ToS N images from modelId
    // <id>` — that number is a MODEL id, not this account.
    //
    // `\\y` and not `\y`: in a template literal `\y` is an unrecognised escape and collapses to a bare
    // `y`, so the pattern silently became `y<id>y` and matched nothing.
    .where(
      sql<boolean>`"ActionType" ~ ('(from |[Uu]ser |[Uu]serID |on user |for user |to \\()' || ${String(
        userId
      )} || '\\y')`
    )
    .orderBy('Event', 'desc')
    .limit(limit)
    .execute();
  return rows as RetoolActivityRow[];
}

// TRAINING RUNS (Retool's NewSubmittedTrainsBrett). The summary line is what a moderator acts on: what
// was trained, from what, how far it got, how much it cost and whether it is public.
//
// `params` is Retool's ~20 hyperparameters, which this file previously dropped as debugging detail. The
// mod team asked for them back ("display the metadata of the training"), so the whole object is carried
// rather than a chosen subset: the key set varies by engine — around 30 across the corpus, with
// `ecosystem`/`lr`/`epochs` on newer runs and `unetLR`/`maxTrainEpochs` on older ones — so enumerating
// columns would silently drop whatever a new engine adds.
export type TrainingRun = {
  modelVersionId: number;
  modelId: number;
  modelName: string | null;
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
  submittedAt: string | null;
  completedAt: string | null;
  engine: string | null;
  params: Record<string, unknown> | null;
  /** Submissions against this ONE version. A retrain reuses the row, so a version is not a run. */
  submitCount: number | null;
  history: { time: string; status: string }[] | null;
};

export async function getTrainingRuns(
  userId: number,
  limit = 25
): Promise<{ runs: TrainingRun[]; truncated: boolean; charges: TrainingCharges | null }> {
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
      'm.name as modelName',
      'mv.name',
      'mv.trainingStatus',
      sql<string | null>`mv."trainingDetails"::json ->> 'baseModel'`.as('baseModel'),
      sql<string | null>`mv."trainingDetails"::json ->> 'type'`.as('trainingType'),
      sql<string | null>`mv."trainingDetails"::json -> 'params' ->> 'engine'`.as('engine'),
      sql<Record<string, unknown> | null>`mv."trainingDetails"::jsonb -> 'params'`.as('params'),
      sql<
        number | null
      >`nullif(mv."trainingDetails"::json -> 'params' ->> 'maxTrainEpochs', '')::int`.as(
        'maxEpochs'
      ),
      sql<number | null>`nullif(mf.metadata::json ->> 'numImages', '')::int`.as('numImages'),
      sql<string | null>`mf.metadata::json ->> 'shareDataset'`.as('sharedDataset'),
      sql<number | null>`json_array_length(mf.metadata::json -> 'trainingResults' -> 'epochs')`.as(
        'currentEpoch'
      ),
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
      sql<string | null>`mf.metadata::json -> 'trainingResults' ->> 'submittedAt'`.as(
        'submittedAt'
      ),
      sql<string | null>`coalesce(
        mf.metadata::json -> 'trainingResults' ->> 'completedAt',
        mf.metadata::json -> 'trainingResults' ->> 'end_time'
      )`.as('completedAt'),
      // Guarded on the type rather than run bare: `jsonb_array_elements` raises on a non-array, which
      // would take down the whole /api/user-account payload, not just this panel.
      sql<{ time: string; status: string }[] | null>`
        CASE WHEN jsonb_typeof(mf.metadata::jsonb -> 'trainingResults' -> 'history') = 'array'
             THEN mf.metadata::jsonb -> 'trainingResults' -> 'history' END
      `.as('history'),
      sql<number | null>`
        CASE WHEN jsonb_typeof(mf.metadata::jsonb -> 'trainingResults' -> 'history') = 'array' THEN (
          SELECT count(*)::int
          FROM jsonb_array_elements(mf.metadata::jsonb -> 'trainingResults' -> 'history') AS h(val)
          WHERE h.val ->> 'status' = 'Submitted'
        ) END
      `.as('submitCount'),
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
    modelName: r.modelName,
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
    submittedAt: r.submittedAt,
    completedAt: r.completedAt,
    engine: r.engine,
    submitCount: r.submitCount === null ? null : Number(r.submitCount),
    history: r.history,
    params: r.params,
  }));

  return { runs, truncated, charges: await getTrainingCharges(userId, runs) };
}

export type TrainingChargeRow = {
  id: string;
  date: string;
  buzz: number;
  /** The run's own id in the orchestrator, `<userId>-<timestamp>`. Carried on every charge since
   *  2024-10; older ones have none. It is all the identity a deleted run has left. */
  workflowId: string | null;
};

export type TrainingCharges = {
  count: number;
  buzz: number;
  first: string | null;
  last: string | null;
  /** Charges with no surviving run — the deleted ones, newest first. Capped; `truncated` says so. */
  unmatched: TrainingChargeRow[];
  truncated: boolean;
};

/** Widest gap seen between a charge and the run's own `submittedAt` is under a second; a minute of slack
 *  absorbs clock skew without being wide enough to swallow a genuinely separate submission. */
const CHARGE_MATCH_MS = 60_000;

const MAX_UNMATCHED = 200;

/**
 * Charges this account was billed that no surviving run accounts for — the deleted runs.
 *
 * 🔴 Dates arrive in both shapes (zone-marked from `getTrainingCharges`, raw ClickHouse elsewhere) and
 * are compared, not displayed — parsing one as local shifts it and matches nothing, which fails as
 * "all runs deleted" on a healthy account. Pinned by a test.
 */
export function unaccountedCharges(
  charges: TrainingChargeRow[],
  submitTimes: (string | null)[]
): TrainingChargeRow[] {
  const submitted = submitTimes.flatMap((time) => {
    const ms = time ? utcMs(time) : NaN;
    return Number.isNaN(ms) ? [] : [ms];
  });
  return charges.filter((charge) => {
    const ms = utcMs(charge.date);
    if (Number.isNaN(ms)) return true;
    return !submitted.some((t) => Math.abs(t - ms) <= CHARGE_MATCH_MS);
  });
}

/**
 * Every training this account has PAID for, from the Buzz ledger, minus the ones a surviving run
 * already accounts for.
 *
 * The rows above cannot answer "how many trainings has this account run": `remove-old-drafts` issues a
 * raw `DELETE FROM "Model"` for any Draft model untouched for 30 days, so a run that was never published
 * takes its version, its training file and its whole record with it. One ledger entry is written per
 * submission (verified: an account holding 24 charges and one surviving version, with the survivor's
 * `submittedAt` matching its charge to the second), and ClickHouse keeps them back to 2023 unpruned.
 *
 * So the ledger is the run LIST, not just a count: every charge is a submission, and the ones that match
 * no surviving run are exactly the runs whose record was deleted.
 *
 * Fails soft. This is a footnote on one panel, and the endpoint that calls it is a single `Promise.all`
 * over twelve queries — a ClickHouse blip must not take the other eleven panels down with it.
 */
async function getTrainingCharges(
  userId: number,
  runs: TrainingRun[]
): Promise<TrainingCharges | null> {
  try {
    const rows = await getClickhouse().$query<{
      id: string;
      date: string;
      buzz: string;
      workflowId: string;
    }>(`
      SELECT
        transactionId AS id,
        date,
        amount AS buzz,
        JSONExtractString(details, 'workflowId') AS workflowId
      FROM buzzTransactions
      WHERE type = 'training' AND fromAccountId = ${Math.trunc(userId)}
      ORDER BY date DESC
    `);
    if (!rows.length) return null;

    // A retrain reuses the version, so one run can account for several charges — every `Submitted` in
    // its history is one. `submittedAt` covers the ~8% of files with no history array.
    const submitTimes = runs.flatMap((run) => [
      ...(run.history ?? []).filter((h) => h.status === 'Submitted').map((h) => h.time),
      run.submittedAt,
    ]);

    const unmatched = unaccountedCharges(
      rows.map((r) => ({
        id: r.id,
        date: clickhouseDate(r.date),
        buzz: Number(r.buzz),
        workflowId: r.workflowId || null,
      })),
      submitTimes
    );

    return {
      count: rows.length,
      buzz: rows.reduce((sum, r) => sum + Number(r.buzz), 0),
      first: clickhouseDate(rows[rows.length - 1]?.date ?? '') || null,
      last: clickhouseDate(rows[0]?.date ?? '') || null,
      unmatched: unmatched.slice(0, MAX_UNMATCHED),
      truncated: unmatched.length > MAX_UNMATCHED,
    };
  } catch {
    return null;
  }
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

/**
 * Retool ran this as two queries — `Payments` (`fromAccountId = user`, money OUT) and `Receipts`
 * (`toAccountId = user`, money IN) — shown side by side, each with its own filters. One merged list
 * cannot answer "what did this account spend" without the reader sorting it by eye, which is the
 * question a farming or chargeback investigation actually asks.
 */
export async function getBuzzHistory(
  userId: number,
  days = 90,
  /** `includeBank` is an access decision, not a filter — see the caller. */
  { limit = 200, includeBank = true }: { limit?: number; includeBank?: boolean } = {}
): Promise<{
  payments: BuzzTransaction[];
  receipts: BuzzTransaction[];
  days: number;
  truncated: boolean;
}> {
  const rows = await getClickhouse().$query<{
    transactionId: string;
    date: string;
    direction: string;
    amount: string;
    accountType: string;
    type: string;
    description: string;
    externalTransactionId: string;
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
      externalTransactionId,
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

  const mapped: BuzzTransaction[] = page.map((r) => {
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
      counterpartyName: isUser ? byId.get(id)?.username ?? null : null,
      counterpartyLabel: isUser ? null : counterpartyLabel(r.counterpartyType, id),
      externalTransactionId: r.externalTransactionId || null,
    };
  });

  // Retool restricted `bank` rows to admins. Filtered after mapping rather than in the ClickHouse
  // WHERE so `truncated` still describes the real window — a moderator who cannot see bank rows must
  // not also be told the window was shorter than it was.
  const visible = includeBank ? mapped : mapped.filter((t) => t.type !== 'bank');

  return {
    days,
    truncated,
    payments: visible.filter((t) => t.direction === 'out'),
    receipts: visible.filter((t) => t.direction === 'in'),
  };
}

/** One `CsamReport` row, reduced to what the classification says. The report's `images` and the
 *  NCMEC contact fields are deliberately not selected — this answers "what was this account reported
 *  for and did it go out", which is the question the header chip raises, without putting the material
 *  itself in a moderation console. */
export type CsamReportRow = {
  id: number;
  createdAt: Date;
  type: string;
  reportedByUsername: string | null;
  reportSentAt: Date | null;
  archivedAt: Date | null;
  contentRemovedAt: Date | null;
  reportId: number | null;
  minorDepiction: string | null;
  contents: string[];
  /** Entry count only. `details->'userActivity'` is the account's whole session log — one report here
   *  carried 89,550 entries, each with an IP — so it is summarised rather than sent. */
  userActivityCount: number;
  imageCount: number;
  modelVersionCount: number;
};

export async function getCsamReports(userId: number): Promise<CsamReportRow[]> {
  const rows = await dbRead
    .selectFrom('CsamReport as cr')
    .leftJoin('User as u', 'u.id', 'cr.reportedById')
    .select([
      'cr.id',
      'cr.createdAt',
      sql<string>`cr.type::text`.as('type'),
      'u.username as reportedByUsername',
      'cr.reportSentAt',
      'cr.archivedAt',
      'cr.contentRemovedAt',
      'cr.reportId',
      sql<string | null>`cr.details->>'minorDepiction'`.as('minorDepiction'),
      sql<string[] | null>`cr.details->'contents'`.as('contents'),
      // jsonb_array_length errors on a non-array, and these columns are sometimes an object or null.
      sql<number>`CASE WHEN jsonb_typeof(cr.details->'userActivity') = 'array'
        THEN jsonb_array_length(cr.details->'userActivity') ELSE 0 END`.as('userActivityCount'),
      sql<number>`CASE WHEN jsonb_typeof(cr.images) = 'array' THEN jsonb_array_length(cr.images) ELSE 0 END`.as(
        'imageCount'
      ),
      sql<number>`CASE WHEN jsonb_typeof(cr.details->'modelVersionIds') = 'array'
        THEN jsonb_array_length(cr.details->'modelVersionIds') ELSE 0 END`.as('modelVersionCount'),
    ])
    .where('cr.userId', '=', userId)
    .orderBy('cr.createdAt', 'desc')
    .execute();

  return rows.map((r) => ({
    ...r,
    contents: Array.isArray(r.contents) ? r.contents : [],
    userActivityCount: Number(r.userActivityCount ?? 0),
    imageCount: Number(r.imageCount ?? 0),
    modelVersionCount: Number(r.modelVersionCount ?? 0),
  }));
}

// PAYOUTS. Asked for as "show a list of their payouts, (Tipalti connection needed?)" — the answer is no.
// Tipalti is the processor, but every request and its state is a row here, so this needs no integration.
//
// Two tables because there are two eras and they are not the same object: `BuzzWithdrawalRequest` is the
// creator-programme path (buzz converted at a platform fee, sent via a provider) and `CashWithdrawal` is
// the cash-balance one. Merged into one timeline, tagged, because "has this account been paid, and did
// anything fail" is one question.
export type Payout = {
  key: string;
  kind: 'buzz' | 'cash';
  /** Nullable: `CashWithdrawal.createdAt` has no NOT NULL, unlike the buzz table's. */
  createdAt: Date | null;
  status: string;
  /** Buzz for a `buzz` row, cents for a `cash` one — the two are not addable, hence the kind. */
  requested: number;
  /** What actually moved, when it did. Null on a request nothing has been transferred against. */
  transferred: number | null;
  provider: string | null;
  note: string | null;
};

export async function getPayouts(userId: number, limit = 50): Promise<Capped<Payout>> {
  const [buzz, cash] = await Promise.all([
    dbRead
      .selectFrom('BuzzWithdrawalRequest')
      .select([
        'id',
        'createdAt',
        sql<string>`status::text`.as('status'),
        'requestedBuzzAmount as requested',
        'transferredAmount as transferred',
        sql<string | null>`"requestedToProvider"::text`.as('provider'),
      ])
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit + 1)
      .execute(),
    dbRead
      .selectFrom('CashWithdrawal')
      .select([
        'id',
        'createdAt',
        sql<string>`status::text`.as('status'),
        'amount as requested',
        sql<string | null>`method::text`.as('provider'),
        'note',
      ])
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit + 1)
      .execute(),
  ]);

  const rows: Payout[] = [
    ...buzz.map((r) => ({
      // Ids are text and the two tables can collide, so the key carries its source.
      key: `buzz:${r.id}`,
      kind: 'buzz' as const,
      createdAt: r.createdAt,
      status: r.status,
      requested: Number(r.requested ?? 0),
      transferred: r.transferred === null ? null : Number(r.transferred),
      provider: r.provider,
      note: null,
    })),
    ...cash.map((r) => ({
      key: `cash:${r.id}`,
      kind: 'cash' as const,
      createdAt: r.createdAt,
      status: r.status,
      requested: Number(r.requested ?? 0),
      transferred: null,
      provider: r.provider,
      note: r.note,
    })),
    // Undated rows sort last rather than crashing the comparator or silently leading the list.
  ].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  return capped(rows, limit);
}
