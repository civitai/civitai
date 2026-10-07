import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { userBasicCache } from '~/server/redis/caches';
import { SYSTEM_USER_ID } from '~/server/services/creator-milestone-exclusions';
import {
  creatorMilestoneRegistry,
  isMilestoneAnnounced,
} from '~/server/services/creator-milestone-registry';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';

const SUPERNOVA = 'score:supernova';
const LEGEND = 'score:legend';

type ShowcaseRow = { userId: number; milestoneKey: string; achievedAt: Date };

/** `timestamp(3)` columns hold UTC wall time, so compare against a zoneless UTC literal. */
const toUtcTimestamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

/**
 * Supernovas granted silently at launch did not cross this month, they were backfilled, so the
 * monthly roll starts no earlier than the tier's launch.
 */
export function newSupernovaCutoff(now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { launchedAt } = creatorMilestoneRegistry[SUPERNOVA];
  return monthStart > launchedAt ? monthStart : launchedAt;
}

/**
 * Public lists hold creators in good standing, which is stricter than the grant filter: muted,
 * metric-suppressed and actively struck accounts keep their badges but are not showcased.
 */
export async function getShowcaseRows(
  pg: AugmentedPool,
  { now, excludedUserIds }: { now: Date; excludedUserIds: number[] }
) {
  const query = await pg.cancellableQuery<ShowcaseRow>(
    `
    SELECT ucm."userId", ucm."milestoneKey", ucm."achievedAt"
    FROM "UserCreatorMilestone" ucm
    JOIN "User" u ON u.id = ucm."userId"
    WHERE (
        ucm."milestoneKey" = $1
        OR (ucm."milestoneKey" = $2 AND ucm."achievedAt" >= $3::timestamp)
      )
      AND u.id <> ${SYSTEM_USER_ID}
      AND u."deletedAt" IS NULL
      AND u."bannedAt" IS NULL
      AND NOT u.muted
      AND u.id <> ALL($4::int[])
      AND NOT EXISTS (
        SELECT 1 FROM "UserStrike" s
        WHERE s."userId" = u.id AND s.status = 'Active' AND s."expiresAt" > $5::timestamp
      )
    ORDER BY ucm."achievedAt", ucm."userId"
    `,
    [
      LEGEND,
      SUPERNOVA,
      toUtcTimestamp(newSupernovaCutoff(now)),
      excludedUserIds,
      toUtcTimestamp(now),
    ]
  );
  return query.result();
}

export async function getCreatorShowcase() {
  const rows = await getShowcaseRows(pgDbRead, {
    now: new Date(),
    // Fails closed: an unreadable list would put suppressed accounts on a public page.
    excludedUserIds: await getMetricExcludedUserIdsOrThrow(),
  });
  const users = await userBasicCache.fetch([...new Set(rows.map((row) => row.userId))]);
  const withUser = (row: ShowcaseRow) => {
    const user = users[row.userId];
    return { id: row.userId, username: user?.username ?? null, image: user?.image ?? null };
  };

  return {
    newSupernovas: rows
      .filter((row) => row.milestoneKey === SUPERNOVA)
      .reverse()
      .map((row) => ({ user: withUser(row), achievedAt: row.achievedAt })),
    legends: rows
      .filter((row) => row.milestoneKey === LEGEND)
      .map((row) => {
        const founding = !isMilestoneAnnounced(LEGEND, row.achievedAt);
        return { user: withUser(row), founding, since: founding ? null : row.achievedAt };
      }),
  };
}
