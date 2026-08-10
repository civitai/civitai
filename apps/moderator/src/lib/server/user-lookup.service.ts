import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { REPORT_SOURCES } from './report-sources';
import { strikeCountsByUserIds } from './moderation-memory.service';
import { getModeratorContact, type ModeratorContact } from './user-signals.service';

// The PAGE LOAD half of User Lookup — identity, profile, score, counts, stats, reports, subscription.
// One file per endpoint is the rule for this page's services; the sibling files are
// user-signals.service.ts and user-account.service.ts.
//
// Ported from Retool (UserIDByUsername / UserIDByEmail / UserContent /
// AllCountsUnion / UserStats). Investigation only — every read goes to the replica so looking a user up
// never touches the primary.

export type UserIdentity = {
  id: number;
  username: string | null;
  /** Retool's UpdateUserDeets edits this alongside username and email. */
  name: string | null;
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
  /** Retool showed both as header chips on every section. */
  csamReportCount: number;
  /** Pending + Processing reports filed AGAINST this account. */
  openReportCount: number;
  /** `Pending` means a SYSTEM restriction nobody has ruled on — the case where `mutedAt` is null and
   *  the account still reads as muted. `null` when the account has never been restricted. */
  restrictionStatus: string | null;
  restrictionType: string | null;
  /** Quick Info in Retool. `onboarding` is a bitfield; nonzero means the TOS step is done. */
  onboarding: number | null;
  excludeFromLeaderboards: boolean | null;
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
  curator: CuratorStatus;
  ranks: LeaderboardRank[];
  /** Header chip. Lives in the moderator database, so it cannot ride the identity query. */
  strikeCount: number;
  /** Prior moderator contact. In the load rather than the signals endpoint because it is a header
   *  warning: acting on an account without knowing a mod already spoke to them is the failure. */
  modContact: ModeratorContact;
};

// Retool used three separate queries behind three inputs; one resolver keeps the caller from having to
// know which kind of identifier it holds. Numeric input is tried as an id first, then as a username —
// usernames can be all digits.
export async function resolveUserId(term: string): Promise<number | null> {
  const value = term.trim();
  if (!value) return null;

  // Bounded HERE, not at the call sites: `User.id` is int4, so an over-long digit string errors the
  // comparison rather than missing — and this runs inside User Lookup's LAYOUT load, so one extra
  // digit rendered a 500 on every section instead of "no user matches". Falling through rather than
  // returning null is deliberate: all-digit usernames exist.
  if (/^\d+$/.test(value) && Number(value) <= 2_147_483_647) {
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

/** The username as stored, for actions that make a moderator type it back to confirm. */
export async function resolveUsername(userId: number): Promise<{ username: string | null } | null> {
  const row = await dbRead
    .selectFrom('User')
    .select('username')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row ?? null;
}

export async function getUserLookup(userId: number): Promise<UserLookupResult | null> {
  const [
    identity,
    profile,
    scores,
    counts,
    stats,
    reportsFiled,
    reportedContent,
    subscription,
    curator,
    ranks,
    strikes,
    modContact,
  ] = await Promise.all([
    getIdentity(userId),
    getProfile(userId),
    getScores(userId),
    getCounts(userId),
    getStats(userId),
    getReportsFiled(userId),
    getReportedContent(userId),
    getSubscription(userId),
    getCuratorStatus(userId),
    getLeaderboardRanks(userId),
    // A different database, so it rides the same Promise.all rather than a second round trip. Failure
    // degrades to "no strikes shown": the moderator database being down must not blank a lookup.
    strikeCountsByUserIds([userId]).catch(() => new Map<number, number>()),
    getModeratorContact(userId),
  ]);
  return identity
    ? {
        identity,
        profile,
        scores,
        counts,
        stats,
        reportsFiled,
        reportedContent,
        subscription,
        curator,
        ranks,
        strikeCount: strikes.get(userId) ?? 0,
        modContact,
      }
    : null;
}

// CURATOR STATUS (Retool's CuratorStatus / CuratorStatus2). Curators hold elevated permissions on the
// featured collections, so it changes what an account can already do and belongs beside identity — a
// moderator acting on one without knowing is the failure this prevents.
//
// The collection ids are Retool's, carried over verbatim: they are the featured collections the
// curation programme runs on, and there is no flag on `Collection` that identifies them.
const CURATED_COLLECTION_IDS = [104, 105, 106, 107];

export type CuratorStatus = { isCurator: boolean; collectionIds: number[] };

export async function getCuratorStatus(userId: number): Promise<CuratorStatus> {
  const rows = await dbRead
    .selectFrom('CollectionContributor')
    .select('collectionId')
    .where('userId', '=', userId)
    .where('collectionId', 'in', CURATED_COLLECTION_IDS)
    // Retool matched the permission ARRAY literally against '{VIEW,ADD}' / '{VIEW,ADD_REVIEW}', so a
    // curator whose row also carries MANAGE — the most privileged case — did not match at all.
    .where(
      sql<boolean>`permissions && ARRAY['ADD','ADD_REVIEW','MANAGE']::"CollectionContributorPermission"[]`
    )
    .execute();
  return { isCurator: rows.length > 0, collectionIds: rows.map((r) => r.collectionId) };
}

// LEADERBOARD POSITIONS (Retool's UserRank) — a top-100 placement is a reward-eligibility signal, and
// the reason a farming investigation matters commercially.
export type LeaderboardRank = {
  leaderboardId: string;
  position: number;
  score: number;
  date: Date;
};

export async function getLeaderboardRanks(userId: number): Promise<LeaderboardRank[]> {
  return (
    dbRead
      .selectFrom('LeaderboardResult')
      // One row per board: the table holds a row per DAY, so without this a single board contributes
      // thirty near-identical rows and crowds out the others.
      .distinctOn('leaderboardId')
      .select(['leaderboardId', 'position', 'score', 'date'])
      .where('userId', '=', userId)
      .where('position', '<', 100)
      .where('date', '>=', sql<Date>`now() - interval '30 days'`)
      .orderBy('leaderboardId')
      .orderBy('date', 'desc')
      .execute()
  );
}

async function getIdentity(userId: number): Promise<UserIdentity | null> {
  const row = await dbRead
    .selectFrom('User as u')
    .select([
      'u.id',
      'u.username',
      'u.name',
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
      'u.onboarding',
      'u.excludeFromLeaderboards',
      // jsonb path extraction has no builder equivalent.
      sql<string | null>`u.meta #>> '{banDetails,reasonCode}'`.as('banReason'),
      sql<string | null>`u.meta #>> '{banDetails,detailsInternal}'`.as('banDetails'),
      // Retool joined both of these into the LANDING query — they are header chips there, not
      // something a moderator has to go looking for. Without them an account with a CSAM report filed
      // against it renders as clean, and a system auto-mute is indistinguishable from a manual one.
      sql<number>`(SELECT COUNT(*)::int FROM "CsamReport" cr WHERE cr."userId" = u.id)`.as(
        'csamReportCount'
      ),
      sql<string | null>`(
        SELECT ur.status::text FROM "UserRestriction" ur
        WHERE ur."userId" = u.id ORDER BY ur.id DESC LIMIT 1
      )`.as('restrictionStatus'),
      sql<string | null>`(
        SELECT ur.type FROM "UserRestriction" ur
        WHERE ur."userId" = u.id ORDER BY ur.id DESC LIMIT 1
      )`.as('restrictionType'),
      // The ticket asked for open reports against the account "very clearly at the top". A report
      // nobody has ruled on changes what every other panel means, and it was reachable only by
      // navigating to the Reports section and reading a list.
      sql<number>`(
        SELECT COUNT(*)::int FROM "UserReport" urp
        JOIN "Report" r ON r.id = urp."reportId"
        WHERE urp."userId" = u.id AND r.status IN ('Pending', 'Processing')
      )`.as('openReportCount'),
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
// Shared with the report ROWS in user-reports.service.ts — see report-sources.ts.
const REPORTED_SOURCES = REPORT_SOURCES;

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
  ).then(async (counts) => {
    // Chat is owned by `ownerId`, so it cannot go through the loop — but leaving it out here while the
    // rows below list it is exactly the count/rows disagreement the shared list exists to prevent.
    const chat = await dbRead
      .selectFrom('Chat')
      .innerJoin('ChatReport', 'ChatReport.chatId', 'Chat.id')
      .select((eb) => eb.fn.count<string>('Chat.id').distinct().as('count'))
      .where('Chat.ownerId', '=', userId)
      .executeTakeFirst();
    return [...counts, { label: 'Chat', count: Number(chat?.count ?? 0) }];
  });
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
