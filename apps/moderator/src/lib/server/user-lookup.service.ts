import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { getBuzz } from './buzz';

// Ported from Retool's "User Lookup v2" (UserIDByUsername / UserIDByEmail / UserContent /
// AllCountsUnion / UserStats). Investigation only — every read goes to the replica so looking a user up
// never touches the primary.

export type UserIdentity = {
  id: number;
  username: string | null;
  email: string | null;
  createdAt: Date | null;
  deletedAt: Date | null;
  emailVerified: Date | null;
  image: string | null;
  isModerator: boolean | null;
  muted: boolean | null;
  mutedAt: Date | null;
  bannedAt: Date | null;
  banReason: string | null;
  banDetails: string | null;
  customerId: string | null;
  paddleCustomerId: string | null;
  rewardsEligibility: string | null;
};

export type UserCount = { label: string; count: number; profilePath: string | null };
export type UserCounts = UserCount[];

// Retool's UserStats selected `ratingAllTime`, which no longer exists on UserStat — thumbs up/down
// replaced it. Reporting those instead rather than dropping the signal.
export type UserStats = {
  followers: number;
  following: number;
  uploads: number;
  downloads: number;
  thumbsUp: number;
  thumbsDown: number;
  generations: number;
};

export type UserProfileText = {
  bio: string | null;
  message: string | null;
  location: string | null;
};

// Civitai score. Every component is optional: `meta->scores` only carries the parts that have been
// computed, so a missing key means "not scored", not zero — roughly half of all users have no scores
// object at all, and of those that do most hold only `total` and one component.
export type UserScores = {
  total: number | null;
  users: number | null;
  images: number | null;
  models: number | null;
  articles: number | null;
  reportsAgainst: number | null;
  reportsActioned: number | null;
};

export type UserLookupResult = {
  identity: UserIdentity;
  profile: UserProfileText | null;
  scores: UserScores | null;
  counts: UserCounts;
  stats: UserStats | null;
  reportsFiled: ReportsFiled;
  reportedContent: ReportedContent[];
  subscription: UserSubscription | null;
};

// Retool used three separate queries behind three inputs; one resolver keeps the caller from having to
// know which kind of identifier it holds. Numeric input is tried as an id first, then as a username —
// usernames can be all digits.
export async function resolveUserId(term: string): Promise<number | null> {
  const value = term.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const byId = await dbRead
      .selectFrom('User')
      .select('id')
      .where('id', '=', Number(value))
      .executeTakeFirst();
    if (byId) return byId.id;
  }

  const column = value.includes('@') ? 'email' : 'username';
  const row = await dbRead
    .selectFrom('User')
    .select('id')
    .where(column, '=', value)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function getUserLookup(userId: number): Promise<UserLookupResult | null> {
  const [identity, profile, scores, counts, stats, reportsFiled, reportedContent, subscription] =
    await Promise.all([
      getIdentity(userId),
      getProfile(userId),
      getScores(userId),
      getCounts(userId),
      getStats(userId),
      getReportsFiled(userId),
      getReportedContent(userId),
      getSubscription(userId),
    ]);
  return identity
    ? { identity, profile, scores, counts, stats, reportsFiled, reportedContent, subscription }
    : null;
}

async function getIdentity(userId: number): Promise<UserIdentity | null> {
  const row = await dbRead
    .selectFrom('User as u')
    .select([
      'u.id',
      'u.username',
      'u.email',
      'u.createdAt',
      'u.deletedAt',
      'u.emailVerified',
      'u.image',
      'u.isModerator',
      'u.muted',
      'u.mutedAt',
      'u.bannedAt',
      'u.customerId',
      'u.paddleCustomerId',
      'u.rewardsEligibility',
      // jsonb path extraction has no builder equivalent.
      sql<string | null>`u.meta #>> '{banDetails,reasonCode}'`.as('banReason'),
      sql<string | null>`u.meta #>> '{banDetails,detailsInternal}'`.as('banDetails'),
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  return (row as UserIdentity | undefined) ?? null;
}

// Retool's UserBio also selected the cover image; the moderator app links to the profile instead of
// re-rendering it, so only the text a moderator reads is ported.
async function getProfile(userId: number): Promise<UserProfileText | null> {
  const row = await dbRead
    .selectFrom('UserProfile')
    .select(['bio', 'message', 'location'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row ?? null;
}

async function getScores(userId: number): Promise<UserScores | null> {
  const row = await dbRead
    .selectFrom('User')
    .select(sql<Record<string, number> | null>`meta -> 'scores'`.as('scores'))
    .where('id', '=', userId)
    .executeTakeFirst();
  const scores = row?.scores;
  if (!scores) return null;

  const at = (key: string) => (typeof scores[key] === 'number' ? scores[key] : null);
  return {
    total: at('total'),
    users: at('users'),
    images: at('images'),
    models: at('models'),
    articles: at('articles'),
    reportsAgainst: at('reportsAgainst'),
    reportsActioned: at('reportsActioned'),
  };
}

// Retool ran these as a UNION ALL of COUNT(*)s. Kept as parallel counts so a new one is a line, not a
// string edit, and so a single slow table cannot stall the rest. `profilePath` is the segment under
// /user/<username> that lists this content — absent where the site has no such page.
const COUNT_SOURCES = [
  ['Models', 'Model', 'models'],
  ['Images', 'Image', 'images'],
  ['Posts', 'Post', 'posts'],
  ['Articles', 'Article', 'articles'],
  ['Collections', 'Collection', 'collections'],
  ['Model comments', 'Comment', null],
  ['Image comments', 'CommentV2', null],
  ['Reviews', 'ResourceReview', null],
] as const;

async function getCounts(userId: number): Promise<UserCounts> {
  return Promise.all(
    COUNT_SOURCES.map(async ([label, table, profilePath]) => {
      const r = await dbRead
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('userId', '=', userId)
        .executeTakeFirst();
      return { label, count: Number(r?.count ?? 0), profilePath };
    })
  );
}

async function getStats(userId: number): Promise<UserStats | null> {
  const row = await dbRead
    .selectFrom('UserStat')
    .select([
      'followerCountAllTime',
      'followingCountAllTime',
      'uploadCountAllTime',
      'downloadCountAllTime',
      'thumbsUpCountAllTime',
      'thumbsDownCountAllTime',
      'generationCountAllTime',
    ])
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    followers: Number(row.followerCountAllTime ?? 0),
    following: Number(row.followingCountAllTime ?? 0),
    uploads: Number(row.uploadCountAllTime ?? 0),
    downloads: Number(row.downloadCountAllTime ?? 0),
    thumbsUp: Number(row.thumbsUpCountAllTime ?? 0),
    thumbsDown: Number(row.thumbsDownCountAllTime ?? 0),
    generations: Number(row.generationCountAllTime ?? 0),
  };
}

// Reports FILED BY this user. Retool showed the actioned/unactioned split because it is a credibility
// signal: a reporter whose reports mostly get actioned is worth trusting, one whose mostly get dismissed
// is noise.
export type ReportsFiled = {
  total: number;
  actioned: number;
  unactioned: number;
  pending: number;
  /** ReportStatus also has `Processing`; without it the four tiles do not sum to `total`. */
  processing: number;
  actionedPercent: number | null;
};

export async function getReportsFiled(userId: number): Promise<ReportsFiled> {
  const row = await dbRead
    .selectFrom('Report')
    .select((eb) => [
      eb.fn.countAll<string>().as('total'),
      eb.fn.count<string>(sql`CASE WHEN "status" = 'Actioned' THEN 1 END`).as('actioned'),
      eb.fn.count<string>(sql`CASE WHEN "status" = 'Unactioned' THEN 1 END`).as('unactioned'),
      eb.fn.count<string>(sql`CASE WHEN "status" = 'Pending' THEN 1 END`).as('pending'),
      eb.fn.count<string>(sql`CASE WHEN "status" = 'Processing' THEN 1 END`).as('processing'),
    ])
    .where('userId', '=', userId)
    .executeTakeFirst();

  const total = Number(row?.total ?? 0);
  const actioned = Number(row?.actioned ?? 0);
  const unactioned = Number(row?.unactioned ?? 0);
  // Percentage is of RESOLVED reports — pending ones have not been judged yet, and counting them as
  // "not actioned" would make an active reporter look unreliable.
  const resolved = actioned + unactioned;
  return {
    total,
    actioned,
    unactioned,
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    actionedPercent: resolved > 0 ? Math.round((actioned / resolved) * 100) : null,
  };
}

// Content OF THIS USER that others reported. Counts distinct pieces of content, not report rows —
// Retool counted rows, so ten reports on one image read as ten. "How much of their content drew
// complaints" is the question a moderator is actually asking.
const REPORTED_SOURCES = [
  ['Images', 'Image', 'ImageReport', 'imageId'],
  ['Models', 'Model', 'ModelReport', 'modelId'],
  ['Posts', 'Post', 'PostReport', 'postId'],
  ['Articles', 'Article', 'ArticleReport', 'articleId'],
  ['Model comments', 'Comment', 'CommentReport', 'commentId'],
  ['Image comments', 'CommentV2', 'CommentV2Report', 'commentV2Id'],
] as const;

export type ReportedContent = { label: string; count: number };

export async function getReportedContent(userId: number): Promise<ReportedContent[]> {
  return Promise.all(
    REPORTED_SOURCES.map(async ([label, table, reportTable, fk]) => {
      const r = await dbRead
        .selectFrom(table as 'Image')
        .innerJoin(
          reportTable as 'ImageReport',
          `${reportTable}.${fk}` as 'ImageReport.imageId',
          `${table}.id` as 'Image.id'
        )
        .select((eb) =>
          eb.fn
            .count<string>(`${table}.id` as 'Image.id')
            .distinct()
            .as('count')
        )
        .where(`${table}.userId` as 'Image.userId', '=', userId)
        .executeTakeFirst();
      return { label, count: Number(r?.count ?? 0) };
    })
  );
}

// SECURITY SIGNALS
//
// `userActivities` is ClickHouse. Use `targetUserId`, NOT `userId`: for Login and Registration rows
// `userId` is empty ~95% of the time (30M of 31.5M logins), so filtering on it silently finds nothing.
//
// The ClickHouse helper interpolates values with NO escaping (formatSqlType returns strings verbatim), so
// only numbers we control and IPs matched against IP_PATTERN are ever put into a query.
const INTERNAL_IP_RANGE = '10.124.0.0/16';
const IP_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

export type UserIp = {
  ip: string;
  type: string;
  first: string;
  last: string;
  events: number;
};

export async function getUserIps(userId: number): Promise<UserIp[]> {
  const rows = await getClickhouse().$query<{
    ip: string;
    type: string;
    first: string;
    last: string;
    events: string;
  }>(`
    SELECT ip, type, min(time) AS first, max(time) AS last, count() AS events
    FROM default.userActivities
    WHERE targetUserId = ${userId}
      AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')
      AND type != 'Banned'
    GROUP BY ip, type
    ORDER BY last DESC
    LIMIT 100
  `);
  return rows.map((r) => ({ ...r, events: Number(r.events) }));
}

export type SharedIpAccount = {
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  ip: string;
  type: string;
  last: string;
};

// Ban-evasion signal: other accounts seen on the IPs this user REGISTERED or SUBSCRIBED from. Retool
// filtered to those two types deliberately — a login IP is often a shared/carrier address, while the
// address an account was created from is far more identifying.
//
// Capped hard at both ends: a carrier NAT can carry thousands of unrelated accounts, and returning them
// all would be slow and useless. A truncated result is reported rather than silently trimmed.
// Identifying IPs are selected by their OWN query, not filtered out of `getUserIps`. That list is
// capped at 100 (ip, type) groups ordered by recency, and a registration is by definition the oldest
// event on the account — so for any busy user the Registration row falls outside the cap and the
// ban-evasion panel silently reports "none found" on exactly the accounts worth investigating.
async function getIdentifyingIps(userId: number): Promise<string[]> {
  const rows = await getClickhouse().$query<{ ip: string }>(`
    SELECT DISTINCT ip
    FROM default.userActivities
    WHERE targetUserId = ${userId}
      AND type IN ('Registration', 'Subscribe')
      AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')
    LIMIT 25
  `);
  return rows.map((r) => r.ip).filter((ip) => IP_PATTERN.test(ip));
}

export async function getSharedIpAccounts(
  userId: number
): Promise<{ accounts: SharedIpAccount[]; truncated: boolean }> {
  const identifying = await getIdentifyingIps(userId);
  if (!identifying.length) return { accounts: [], truncated: false };

  const LIMIT = 100;
  const list = identifying.map((ip) => `'${ip}'`).join(', ');
  const rows = await getClickhouse().$query<{
    userId: string;
    ip: string;
    type: string;
    last: string;
  }>(`
    SELECT targetUserId AS userId, ip, type, max(time) AS last
    FROM default.userActivities
    WHERE ip IN (${list})
      AND targetUserId != ${userId}
      AND targetUserId > 0
    GROUP BY targetUserId, ip, type
    ORDER BY last DESC
    LIMIT ${LIMIT + 1}
  `);

  const truncated = rows.length > LIMIT;
  const page = rows.slice(0, LIMIT);
  const ids = [...new Set(page.map((r) => Number(r.userId)))];
  if (!ids.length) return { accounts: [], truncated };

  const users = await dbRead
    .selectFrom('User')
    .select(['id', 'username', 'bannedAt'])
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(users.map((u) => [u.id, u]));

  return {
    accounts: page.map((r) => {
      const u = byId.get(Number(r.userId));
      return {
        userId: Number(r.userId),
        username: u?.username ?? null,
        bannedAt: u?.bannedAt ?? null,
        ip: r.ip,
        type: r.type,
        last: r.last,
      };
    }),
    truncated,
  };
}

export type UserSocial = { id: number; url: string; type: string };

// Matching key, not a display value: scheme, `www.` and trailing slashes are cosmetic, and treating them
// as significant splits a ring in half. Measured: one spam domain is held by 35 accounts with a trailing
// slash and 25 without, and those two sets do not overlap at all — an exact match reports 24 alts on a
// 60-account ring.
const normalizedUrl = (column: string) =>
  sql<string>`regexp_replace(regexp_replace(lower(btrim(${sql.ref(column)})), '^https?://(www\\.)?', ''), '/+$', '')`;

// `UserLink` has no uniqueness on (userId, url) — one account holds the same link up to 19 times — so
// every read here dedupes. Left raw it renders a link 19 times, and in the shared-account list it
// produces a duplicate `{#each}` key, which Svelte throws on in production from inside the `:then`
// branch where the `{:catch}` cannot see it.
export async function getSocials(userId: number): Promise<UserSocial[]> {
  return dbRead
    .selectFrom('UserLink')
    .select(['id', 'url', 'type'])
    .distinctOn(normalizedUrl('url'))
    .where('userId', '=', userId)
    .orderBy(normalizedUrl('url'))
    .orderBy('id')
    .execute();
}

export type SharedSocialAccount = {
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  url: string;
};

// Ban-evasion signal in the same class as shared IPs, and in practice a sharper one: the most-shared
// links in the table are spam-network domains posted by dozens of accounts each.
//
// Retool did this by SELECTing the entire UserLink table and matching in the browser. Matching in SQL
// as a self-join is worse still — 21s for a user with many links, because it drives a sequential scan
// per link. Two statements instead: collect this user's URLs, then one scan matching all of them (~40ms).
// `url` has no index.
//
// The cap counts ACCOUNTS, not rows. Capping rows let one account holding 25 shared links fill the whole
// window and report "25+ accounts" for what is a single alt, while pushing every genuinely distinct
// account out of sight.
export async function getSharedSocialAccounts(
  userId: number
): Promise<{ accounts: SharedSocialAccount[]; truncated: boolean }> {
  const mine = await dbRead
    .selectFrom('UserLink')
    .select(normalizedUrl('url').as('url'))
    .distinct()
    .where('userId', '=', userId)
    .execute();
  const urls = mine.map((r) => r.url).filter(Boolean);
  if (!urls.length) return { accounts: [], truncated: false };

  const LIMIT = 25;
  const rows = await dbRead
    .selectFrom('UserLink as ul')
    .innerJoin('User as u', 'u.id', 'ul.userId')
    .select(['ul.userId', 'ul.url', 'u.username', 'u.bannedAt'])
    .distinctOn('ul.userId')
    .where(normalizedUrl('ul.url'), 'in', urls)
    .where('ul.userId', '!=', userId)
    .orderBy('ul.userId')
    .orderBy('ul.id')
    .limit(LIMIT + 1)
    .execute();

  // DISTINCT ON fixes the row order, so banned-first ordering is applied here rather than in SQL.
  const sorted = rows.sort((a, b) => Number(!!b.bannedAt) - Number(!!a.bannedAt));
  return { accounts: sorted.slice(0, LIMIT), truncated: sorted.length > LIMIT };
}

// Retool's PotentialSpammer/V2 (Postgres, despite sitting beside the ClickHouse queries): a burst of
// comments in a short window. V2 supersedes V1 by summing both comment tables instead of returning a row
// per table, so only that behaviour is ported.
export async function getCommentBurst(userId: number): Promise<number> {
  const [v2, v1] = await Promise.all(
    (['CommentV2', 'Comment'] as const).map(async (table) => {
      const r = await dbRead
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('userId', '=', userId)
        .where('createdAt', '>', sql<Date>`now() - interval '2 days'`)
        .executeTakeFirst();
      return Number(r?.count ?? 0);
    })
  );
  return v2 + v1;
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

  const modIds = [
    ...new Set(rows.map((r) => r.userId).filter((id): id is number => !!id && id > 0)),
  ];
  const mods = modIds.length
    ? await dbRead.selectFrom('User').select(['id', 'username']).where('id', 'in', modIds).execute()
    : [];
  const byId = new Map(mods.map((m) => [m.id, m.username]));

  return rows.map((r) => ({
    id: r.id,
    activity: r.activity,
    entityType: r.entityType ?? '',
    entityId: r.entityId,
    createdAt: r.createdAt,
    moderatorId: r.userId,
    moderatorUsername: r.userId ? byId.get(r.userId) ?? null : null,
  }));
}

// SUBSCRIPTION (Retool's UserSubscriptionStatus). Postgres only and cheap, so it rides the page load.
export type UserSubscription = {
  productName: string | null;
  provider: string | null;
  status: string;
  buzzType: string | null;
  cancelAtPeriodEnd: boolean | null;
  canceledAt: Date | null;
  currentPeriodEnd: Date | null;
};

// CustomerSubscription is unique on (userId, buzzType) — multiple rows per user are by design, and
// referrals deliberately add a `referral` row that can outlast a paid one. Ordering by period end alone
// would report the referral grant as the user's plan, so filter to the paid subscription the main app
// treats as canonical and surface `buzzType` regardless.
const PAID_BUZZ_TYPE = 'yellow';

export async function getSubscription(userId: number): Promise<UserSubscription | null> {
  const select = [
    'p.name as productName',
    'p.provider',
    'cs.status',
    'cs.buzzType',
    'cs.cancelAtPeriodEnd',
    'cs.canceledAt',
    'cs.currentPeriodEnd',
  ] as const;

  const paid = await dbRead
    .selectFrom('CustomerSubscription as cs')
    .leftJoin('Product as p', 'p.id', 'cs.productId')
    .select(select)
    .where('cs.userId', '=', userId)
    .where('cs.buzzType', '=', PAID_BUZZ_TYPE)
    .executeTakeFirst();
  if (paid) return paid as UserSubscription;

  // No paid row — show whatever they do have rather than nothing, with buzzType visible.
  const other = await dbRead
    .selectFrom('CustomerSubscription as cs')
    .leftJoin('Product as p', 'p.id', 'cs.productId')
    .select(select)
    .where('cs.userId', '=', userId)
    .orderBy('cs.currentPeriodEnd', 'desc')
    .executeTakeFirst();
  return (other as UserSubscription | undefined) ?? null;
}

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

// BUZZ balance (Retool's GetAccountBuzz → buzz.civitai.com/account/user/<id>). An external HTTP call, so
// it never rides the page load. Best-effort: Buzz being down should not blank the rest of the panel.
export type UserBuzz = { balance: number; lifetimeBalance: number } | null;

export async function getBuzzBalance(userId: number): Promise<UserBuzz> {
  try {
    const account = await getBuzz().getAccount(userId);
    return { balance: account.balance, lifetimeBalance: account.lifetimeBalance };
  } catch (e) {
    console.error('[user-lookup] buzz balance unavailable', e);
    return null;
  }
}
