import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { OWNED_REPORT_ENTITIES, chatReportSubject } from './report-entities';
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
  /** The avatar behind `profilePictureId`. `image` above is the legacy URL and is not the same thing. */
  browsingLevel: number | null;
  /** Comma-separated moderator usernames who filed an OPEN report on this account, or null. */
  openReportModerators: string | null;
  profilePictureUrl: string | null;
  profilePictureType: string | null;
  profilePictureNsfwLevel: number | null;
  /** `Pending` means a SYSTEM restriction nobody has ruled on — the case where `mutedAt` is null and
   *  the account still reads as muted. `null` when the account has never been restricted. */
  restrictionStatus: string | null;
  restrictionType: string | null;
  /** The row behind the two above, so a Pending one can be ruled on rather than only read. */
  restrictionId: number | null;
  /** Quick Info in Retool. `onboarding` is a bitfield; nonzero means the TOS step is done. */
  onboarding: number | null;
  excludeFromLeaderboards: boolean | null;
  showNsfw: boolean | null;
  blurNsfw: boolean | null;
};

export type UserCount = {
  label: string;
  count: number;
  profilePath: string | null;
  /** Section slug under /retool/user-lookup, or the bulk-image-manager cross-link. Preferred over
   *  `profilePath`: the public profile hides exactly the content a moderator came to look at. */
  appSection: string | null;
  /** Retool's per-flag breakdown, on the two entities that had one. Absent elsewhere, not zero. */
  flags?: { label: string; count: number }[];
};
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

export type ProfileMedia = {
  /** Cloudflare key (Image.url), not the numeric id — what EdgeMedia takes as `src`. */
  url: string;
  type: string | null;
  nsfwLevel: number | null;
};

export type UserProfileText = {
  bio: string | null;
  message: string | null;
  location: string | null;
  /** Retool's "Look at Cover Image". Both are kept: an account can pass on the SFW one and fail on
   *  the real one, and a moderator asked about a cover has to see the one that was reported. */
  coverImage: ProfileMedia | null;
  sfwCoverImage: ProfileMedia | null;
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
  /** Retool-era strikes, from the moderator database. Historical: the main app's strike system does
   *  NOT write here, so this alone reads 0 on an account carrying active strikes. */
  legacyStrikeCount: number;
  /** The number that means "how much rope is left": active, unexpired, unvoided main-app strikes and
   *  their points. */
  strikes: { count: number; points: number };
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

/**
 * The main app's own strikes (`UserStrike`), which are a different table from the moderator database's
 * Retool-era `UserStrikes`. Nothing writes both, so counting only the legacy one showed 0 for every
 * strike the live system has issued — on a header chip that exists to say how much rope is left.
 */
async function getActiveStrikes(userId: number): Promise<{ count: number; points: number }> {
  const row = await dbRead
    .selectFrom('UserStrike')
    .select((eb) => [
      eb.fn.countAll<string>().as('count'),
      eb.fn.coalesce(eb.fn.sum<string>('points'), sql<string>`0`).as('points'),
    ])
    .where('userId', '=', userId)
    .where('status', '=', 'Active')
    .where('voidedAt', 'is', null)
    .where('expiresAt', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return { count: Number(row?.count ?? 0), points: Number(row?.points ?? 0) };
}

export type LiveStrike = {
  id: number;
  reason: string;
  description: string;
  points: number;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  voidedAt: Date | null;
  issuedBy: number | null;
};

/**
 * The strike ROWS, where `getActiveStrikes` answers the header chip's "how much rope is left". Voided
 * and expired ones are included: a moderator deciding on the next action needs the account's history,
 * and a strike that has already lapsed is the thing that says this has happened before.
 */
export async function getLiveStrikes(userId: number, limit = 50): Promise<LiveStrike[]> {
  return dbRead
    .selectFrom('UserStrike')
    .select([
      'id',
      'reason',
      'description',
      'points',
      'status',
      'createdAt',
      'expiresAt',
      'voidedAt',
      'issuedBy',
    ])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .execute();
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
    legacyStrikes,
    modContact,
    strikes,
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
    // Unbounded scan over ChatMessage; a slow or failing one must not blank the whole lookup, which
    // is what moving it out of /api/user-signals would otherwise have cost.
    getModeratorContact(userId).catch(() => ({ chats: null, lastAt: null, chatIds: [] })),
    getActiveStrikes(userId),
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
        legacyStrikeCount: legacyStrikes.get(userId) ?? 0,
        strikes,
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
      // Retool's "Viewing: PG, PG13, …" — what this account has chosen to be shown, which is context
      // for a report about what they saw or posted.
      'u.browsingLevel',
      // The other half of "what they chose to see": `browsingLevel` is the ceiling, these two are
      // whether mature content is shown at all and whether it arrives blurred.
      'u.showNsfw',
      'u.blurNsfw',
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
      sql<number | null>`(
        SELECT ur.id FROM "UserRestriction" ur
        WHERE ur."userId" = u.id ORDER BY ur.id DESC LIMIT 1
      )`.as('restrictionId'),
      // The ticket asked for open reports against the account "very clearly at the top". A report
      // nobody has ruled on changes what every other panel means, and it was reachable only by
      // navigating to the Reports section and reading a list.
      sql<number>`(
        SELECT COUNT(*)::int FROM "UserReport" urp
        JOIN "Report" r ON r.id = urp."reportId"
        WHERE urp."userId" = u.id AND r.status IN ('Pending', 'Processing')
      )`.as('openReportCount'),
      // Retool's `UserReport by <mod>` chip. An open report is a different fact when a MODERATOR filed
      // it: that is a colleague already working the account, and the anti-overlap case the ticket asks
      // for. The count alone cannot say so.
      sql<string | null>`(
        SELECT string_agg(DISTINCT ru.username, ', ')
        FROM "UserReport" urp
        JOIN "Report" r ON r.id = urp."reportId"
        JOIN "User" ru ON ru.id = r."userId"
        WHERE urp."userId" = u.id
          AND r.status IN ('Pending', 'Processing')
          AND ru."isModerator" IS TRUE
      )`.as('openReportModerators'),
      // Retool's "Look at PFP". `u.image` is the legacy avatar URL and is NOT this — the modern
      // avatar is an Image row behind `profilePictureId`, which carries the nsfwLevel a moderator is
      // actually checking against.
      sql<string | null>`(SELECT i.url FROM "Image" i WHERE i.id = u."profilePictureId")`.as(
        'profilePictureUrl'
      ),
      sql<string | null>`(SELECT i.type::text FROM "Image" i WHERE i.id = u."profilePictureId")`.as(
        'profilePictureType'
      ),
      sql<
        number | null
      >`(SELECT i."nsfwLevel" FROM "Image" i WHERE i.id = u."profilePictureId")`.as(
        'profilePictureNsfwLevel'
      ),
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  return (row as UserIdentity | undefined) ?? null;
}

// Retool's UserBio, including both cover images. Checking a cover or an avatar for ToS content was an
// in-tool action there; linking out to the profile instead means the moderator has to load the very
// page they may be about to act on, in a normal browsing session.
async function getProfile(userId: number): Promise<UserProfileText | null> {
  const row = await dbRead
    .selectFrom('UserProfile as up')
    .leftJoin('Image as ci', 'ci.id', 'up.coverImageId')
    .leftJoin('Image as si', 'si.id', 'up.sfwCoverImageId')
    .select([
      'up.bio',
      'up.message',
      'up.location',
      'ci.url as coverUrl',
      sql<string | null>`ci.type::text`.as('coverType'),
      'ci.nsfwLevel as coverNsfwLevel',
      'si.url as sfwCoverUrl',
      sql<string | null>`si.type::text`.as('sfwCoverType'),
      'si.nsfwLevel as sfwCoverNsfwLevel',
    ])
    .where('up.userId', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    bio: row.bio,
    message: row.message,
    location: row.location,
    coverImage: row.coverUrl
      ? { url: row.coverUrl, type: row.coverType, nsfwLevel: row.coverNsfwLevel }
      : null,
    sfwCoverImage: row.sfwCoverUrl
      ? { url: row.sfwCoverUrl, type: row.sfwCoverType, nsfwLevel: row.sfwCoverNsfwLevel }
      : null,
  };
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
// `[label, table, public profile path, in-app section]`. The fourth entry is preferred when present:
// the public profile does not show deleted, unpublished or TOS'd content, so a count taken here and the
// page it opened legitimately disagreed — which is the opposite of what a drill-down is for.
const COUNT_SOURCES = [
  ['Models', 'Model', 'models', null],
  ['Images', 'Image', 'images', 'bulk-image-manager'],
  ['Posts', 'Post', 'posts', null],
  ['Articles', 'Article', 'articles', null],
  ['Collections', 'Collection', 'collections', null],
  ['Model comments', 'Comment', null, 'comments'],
  ['Image comments', 'CommentV2', null, 'comments'],
  ['Reviews', 'ResourceReview', null, 'reviews'],
  // Retool's ninth row. `AllCountsUnion` does not produce it, so it was invisible to an export-driven
  // port — but a moderator judging harassment is counting DMs.
  ['Chat Messages', 'ChatMessage', null, 'chat'],
] as const;

/**
 * Retool's `ModelCount` and `CommentCount` carried a per-flag breakdown beside the total, and the port
 * kept only the total. "412 models" and "412 models, 9 of them ToS-violating, 3 POI" are different
 * facts about an account, and the second is the one a moderator is looking for.
 *
 * Only these two entities had a breakdown in Retool; the rest report a bare count, and an absent
 * breakdown is "not counted", not "all zero".
 */
async function getModelFlags(userId: number) {
  const r = await dbRead
    .selectFrom('Model')
    .select((eb) => [
      eb.fn.count<string>(sql`CASE WHEN "nsfw" THEN 1 END`).as('nsfw'),
      eb.fn.count<string>(sql`CASE WHEN "tosViolation" THEN 1 END`).as('tos'),
      eb.fn.count<string>(sql`CASE WHEN "poi" THEN 1 END`).as('poi'),
      eb.fn.count<string>(sql`CASE WHEN "locked" THEN 1 END`).as('locked'),
      eb.fn.count<string>(sql`CASE WHEN "deletedAt" IS NOT NULL THEN 1 END`).as('deleted'),
    ])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return [
    { label: 'NSFW', count: Number(r?.nsfw ?? 0) },
    { label: 'ToS', count: Number(r?.tos ?? 0) },
    { label: 'POI', count: Number(r?.poi ?? 0) },
    { label: 'locked', count: Number(r?.locked ?? 0) },
    { label: 'deleted', count: Number(r?.deleted ?? 0) },
  ].filter((f) => f.count > 0);
}

async function getCommentFlags(userId: number) {
  const r = await dbRead
    .selectFrom('Comment')
    .select((eb) => [
      eb.fn.count<string>(sql`CASE WHEN "tosViolation" THEN 1 END`).as('tos'),
      eb.fn.count<string>(sql`CASE WHEN "hidden" THEN 1 END`).as('hidden'),
    ])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return [
    { label: 'ToS', count: Number(r?.tos ?? 0) },
    { label: 'hidden', count: Number(r?.hidden ?? 0) },
  ].filter((f) => f.count > 0);
}

async function getCounts(userId: number): Promise<UserCounts> {
  const [counts, modelFlags, commentFlags] = await Promise.all([
    Promise.all(
      COUNT_SOURCES.map(async ([label, table, profilePath, appSection]) => {
        const r = await dbRead
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('userId', '=', userId)
          .executeTakeFirst();
        return { label, count: Number(r?.count ?? 0), profilePath, appSection };
      })
    ),
    getModelFlags(userId),
    getCommentFlags(userId),
  ]);

  return counts.map((c) =>
    c.label === 'Models'
      ? { ...c, flags: modelFlags }
      : c.label === 'Model comments'
      ? { ...c, flags: commentFlags }
      : c
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

export type ReportedContent = { label: string; count: number };

export async function getReportedContent(userId: number): Promise<ReportedContent[]> {
  return Promise.all(
    OWNED_REPORT_ENTITIES.map(async ({ label, table, reportTable, fk, ownerColumn }) => {
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
        .where(`${table}.${ownerColumn}` as 'Image.userId', '=', userId)
        .executeTakeFirst();
      return { label, count: Number(r?.count ?? 0) };
    })
  ).then(async (counts) => {
    // Chat has no owner column that means "who was reported", so it cannot go through the loop — but
    // leaving it out here while the rows below list it is exactly the count/rows disagreement the
    // shared list exists to prevent. `chatReportSubject` is the one definition of the rule.
    const chat = await dbRead
      .selectFrom('Chat')
      .innerJoin('ChatReport', 'ChatReport.chatId', 'Chat.id')
      .innerJoin('Report as r', 'r.id', 'ChatReport.reportId')
      .select((eb) => eb.fn.count<string>('Chat.id').distinct().as('count'))
      .where(chatReportSubject('Chat.id', 'r', userId))
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
  /** `month` / `year`. Retool kept a whole second query for this: it is what says whether a refund is
   *  a month or a year of value. */
  interval: string | null;
  unitAmount: number | null;
  currency: string | null;
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
    // Retool's UserSubscriptionStatusAnnual was a second query for exactly this column. Annual vs
    // monthly is what decides the amount on a refund or a chargeback, so it rides the one query.
    'pr.interval',
    'pr.unitAmount',
    'pr.currency',
  ] as const;

  const paid = await dbRead
    .selectFrom('CustomerSubscription as cs')
    .leftJoin('Product as p', 'p.id', 'cs.productId')
    .leftJoin('Price as pr', 'pr.id', 'cs.priceId')
    .select(select)
    .where('cs.userId', '=', userId)
    .where('cs.buzzType', '=', PAID_BUZZ_TYPE)
    .executeTakeFirst();
  if (paid) return paid as UserSubscription;

  // No paid row — show whatever they do have rather than nothing, with buzzType visible.
  const other = await dbRead
    .selectFrom('CustomerSubscription as cs')
    .leftJoin('Product as p', 'p.id', 'cs.productId')
    .leftJoin('Price as pr', 'pr.id', 'cs.priceId')
    .select(select)
    .where('cs.userId', '=', userId)
    .orderBy('cs.currentPeriodEnd', 'desc')
    .executeTakeFirst();
  return (other as UserSubscription | undefined) ?? null;
}
