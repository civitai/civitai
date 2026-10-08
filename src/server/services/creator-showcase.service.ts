import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { userBasicCache } from '~/server/redis/caches';
import {
  milestoneShowableUserSql,
  toUtcTimestamp,
} from '~/server/services/creator-milestone-exclusions';
import { CacheTTL } from '~/server/common/constants';
import {
  achievedAtIsObserved,
  achievedAtIsObservedSql,
} from '~/server/services/creator-milestone-grant.service';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';

const SUPERNOVA = 'score:supernova';
export const LEGEND = 'score:legend';

type ShowcaseCandidate = {
  userId: number;
  milestoneKey: string;
  achievedAt: Date;
  seenAt: Date | null;
  achievedMonth: string;
  badgeId: number | null;
};

type ShowcaseRow = Omit<ShowcaseCandidate, 'achievedMonth'>;

const utcMonth = (now: Date) => now.toISOString().slice(0, 7);

const utcPreviousMonthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

/**
 * Every Legend, and every observed Supernova crossing since the start of last UTC month, so a read at
 * any point in the cache's life can apply its own month's window. A silent backfill grant is not new.
 */
async function getShowcaseCandidates(pg: AugmentedPool, now: Date) {
  const query = await pg.cancellableQuery<ShowcaseCandidate>(
    `
    SELECT ucm."userId", ucm."milestoneKey", ucm."achievedAt", ucm."seenAt",
      to_char(ucm."achievedAt", 'YYYY-MM') AS "achievedMonth", m."cosmeticId" AS "badgeId"
    FROM "UserCreatorMilestone" ucm
    JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
    WHERE ucm."milestoneKey" = $1
      OR (
        ucm."milestoneKey" = $2
        AND ucm."achievedAt" >= $3::timestamp
        AND ${achievedAtIsObservedSql('ucm')}
      )
    ORDER BY ucm."achievedAt", ucm."userId"
    `,
    [LEGEND, SUPERNOVA, toUtcTimestamp(utcPreviousMonthStart(now))]
  );
  return query.result();
}

/** Which of `userIds` may be showcased, with their privacy settings: showable and not opted out. */
async function getShowcaseStanding(
  pg: AugmentedPool,
  userIds: number[],
  { now, excludedUserIds }: { now: Date; excludedUserIds: number[] }
) {
  const query = await pg.cancellableQuery<{
    userId: number;
    privacySettings: PrivacySettingsSchema | null;
  }>(
    `
    SELECT u.id AS "userId", p."privacySettings"
    FROM "User" u
    LEFT JOIN "UserProfile" p ON p."userId" = u.id
    WHERE u.id = ANY($1::int[])
      AND ${milestoneShowableUserSql('u', { excludedUserIds: '$2', now: '$3' })}
      AND u.settings -> 'hideFromCreatorShowcase' IS DISTINCT FROM 'true'::jsonb
    `,
    [userIds, excludedUserIds, toUtcTimestamp(now)]
  );
  return new Map((await query.result()).map((row) => [row.userId, row.privacySettings]));
}

/**
 * Every Legend, and the Supernovas whose crossing was observed this UTC month, held by creators in good
 * standing who show the tier's badge. Standing and privacy are read live, so only the candidate list
 * can be stale.
 */
export async function getShowcaseRows(
  pg: AugmentedPool,
  {
    now,
    excludedUserIds,
    candidates,
  }: { now: Date; excludedUserIds: number[]; candidates?: ShowcaseCandidate[] }
) {
  const month = utcMonth(now);
  const inWindow = (candidates ?? (await getShowcaseCandidates(pg, now))).filter(
    (row) => row.milestoneKey === LEGEND || row.achievedMonth === month
  );
  const standing = inWindow.length
    ? await getShowcaseStanding(pg, [...new Set(inWindow.map((row) => row.userId))], {
        now,
        excludedUserIds,
      })
    : new Map<number, PrivacySettingsSchema | null>();
  const rows: ShowcaseRow[] = inWindow
    .filter(
      (row) =>
        standing.has(row.userId) &&
        isBadgeShownOnProfile(standing.get(row.userId) ?? null, row.badgeId)
    )
    .map(({ achievedMonth: _, ...row }) => row);
  return {
    newSupernovas: rows.filter((row) => row.milestoneKey === SUPERNOVA).reverse(),
    legends: rows.filter((row) => row.milestoneKey === LEGEND),
  };
}

export const SHOWCASE_CANDIDATES_TTL = CacheTTL.hour;

export type ShowcaseSource = { pg?: AugmentedPool; now?: Date; retryCount?: number };

/**
 * The showcase page and the Legend profile line's "one of N" both read through here, so N always
 * equals the Hall of Fame's length. Only the candidate list is cached.
 */
export async function getVisibleShowcaseRows({
  pg = pgDbRead,
  now = new Date(),
  retryCount,
}: ShowcaseSource = {}) {
  // Fails closed: an unreadable list would put suppressed accounts on a public page.
  const excludedUserIds = await getMetricExcludedUserIdsOrThrow();
  const candidates = await fetchThroughCache(
    REDIS_KEYS.CACHES.CREATOR_SHOWCASE_CANDIDATES,
    () => getShowcaseCandidates(pg, now),
    { ttl: SHOWCASE_CANDIDATES_TTL, retryCount }
  );
  return getShowcaseRows(pg, { now, excludedUserIds, candidates });
}

export function toLegendStatus(legend: { achievedAt: Date; seenAt: Date | null }) {
  const founding = !achievedAtIsObserved(legend);
  return { founding, since: founding ? null : legend.achievedAt };
}

export async function getCreatorShowcase(source: ShowcaseSource = {}) {
  const { newSupernovas, legends } = await getVisibleShowcaseRows(source);
  const userIds = [...new Set([...newSupernovas, ...legends].map((row) => row.userId))];
  const [users, profilePictures, cosmetics] = await Promise.all([
    userBasicCache.fetch(userIds),
    getProfilePicturesForUsers(userIds),
    getCosmeticsForUsers(userIds),
  ]);
  const withUser = (row: ShowcaseRow) => ({
    id: row.userId,
    username: users[row.userId]?.username ?? null,
    image: users[row.userId]?.image ?? null,
    profilePicture: profilePictures[row.userId] ?? null,
    cosmetics: cosmetics[row.userId] ?? [],
  });

  return {
    newSupernovas: newSupernovas.map((row) => ({
      user: withUser(row),
      achievedAt: row.achievedAt,
    })),
    legends: legends.map((row) => ({ user: withUser(row), ...toLegendStatus(row) })),
  };
}
