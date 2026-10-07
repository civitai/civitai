import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { userBasicCache } from '~/server/redis/caches';
import { milestoneGrantableUserSql } from '~/server/services/creator-milestone-exclusions';
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
const LEGEND = 'score:legend';

type ShowcaseRow = {
  userId: number;
  milestoneKey: string;
  achievedAt: Date;
  seenAt: Date | null;
  badgeId: number | null;
  privacySettings: PrivacySettingsSchema | null;
};

/** `timestamp(3)` columns hold UTC wall time, so compare against a zoneless UTC literal. */
const toUtcTimestamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

const utcMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Every Legend, and the Supernovas whose crossing was observed this UTC month (a silent backfill grant
 * is not new), held by creators in good standing. That is stricter than the grant filter: muted,
 * metric-suppressed, actively struck and leaderboard-excluded accounts keep their badges but are not
 * showcased. An owner who hides the tier's badge, or all badges, is left out too.
 */
export async function getShowcaseRows(
  pg: AugmentedPool,
  { now, excludedUserIds }: { now: Date; excludedUserIds: number[] }
) {
  const query = await pg.cancellableQuery<ShowcaseRow>(
    `
    SELECT ucm."userId", ucm."milestoneKey", ucm."achievedAt", ucm."seenAt",
      m."cosmeticId" AS "badgeId", p."privacySettings"
    FROM "UserCreatorMilestone" ucm
    JOIN "User" u ON u.id = ucm."userId"
    JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
    LEFT JOIN "UserProfile" p ON p."userId" = u.id
    WHERE (
        ucm."milestoneKey" = $1
        OR (
          ucm."milestoneKey" = $2
          AND ucm."achievedAt" >= $3::timestamp
          AND ${achievedAtIsObservedSql('ucm')}
        )
      )
      AND ${milestoneGrantableUserSql('u')}
      AND NOT u.muted
      AND NOT u."excludeFromLeaderboards"
      AND u.id <> ALL($4::int[])
      AND NOT EXISTS (
        SELECT 1 FROM "UserStrike" s
        WHERE s."userId" = u.id AND s.status = 'Active' AND s."expiresAt" > $5::timestamp
      )
    ORDER BY ucm."achievedAt", ucm."userId"
    `,
    [LEGEND, SUPERNOVA, toUtcTimestamp(utcMonthStart(now)), excludedUserIds, toUtcTimestamp(now)]
  );
  const rows = (await query.result()).filter((row) =>
    isBadgeShownOnProfile(row.privacySettings, row.badgeId)
  );
  return {
    newSupernovas: rows.filter((row) => row.milestoneKey === SUPERNOVA).reverse(),
    legends: rows.filter((row) => row.milestoneKey === LEGEND),
  };
}

export const SHOWCASE_ROWS_TTL = CacheTTL.hour;

export type ShowcaseSource = { pg?: AugmentedPool; now?: Date };

/**
 * The showcase page and the Legend profile line's "one of N" both read this one entry, so N always
 * equals the Hall of Fame's length.
 */
export function getCachedShowcaseRows({ pg = pgDbRead, now = new Date() }: ShowcaseSource = {}) {
  return fetchThroughCache(
    REDIS_KEYS.CACHES.CREATOR_SHOWCASE_ROWS,
    async () => {
      // Fails closed: an unreadable list would put suppressed accounts on a public page.
      const excludedUserIds = await getMetricExcludedUserIdsOrThrow();
      return getShowcaseRows(pg, { now, excludedUserIds });
    },
    { ttl: SHOWCASE_ROWS_TTL }
  );
}

export function toLegendStatus(legend: { achievedAt: Date; seenAt: Date | null }) {
  const founding = !achievedAtIsObserved(legend);
  return { founding, since: founding ? null : legend.achievedAt };
}

export async function getCreatorShowcase(source: ShowcaseSource = {}) {
  const { newSupernovas, legends } = await getCachedShowcaseRows(source);
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
