import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

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

export type UserLookupResult = {
  identity: UserIdentity;
  counts: UserCounts;
  stats: UserStats | null;
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
  const [identity, counts, stats] = await Promise.all([
    getIdentity(userId),
    getCounts(userId),
    getStats(userId),
  ]);
  return identity ? { identity, counts, stats } : null;
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
