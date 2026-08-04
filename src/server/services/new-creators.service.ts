import { REDIS_KEYS } from '~/server/redis/client';
import { dbRead } from '~/server/db/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { CacheTTL } from '~/server/common/constants';
import { DomainColor } from '~/shared/utils/prisma/enums';

export const newCreatorEntities = ['images', 'models'] as const;
export type NewCreatorEntity = (typeof newCreatorEntities)[number];

// Only the top slice feeds the browse feed. The board itself stores 1,000, but a
// discovery shelf that reaches position 800 is no longer showcasing anyone, and
// the id list becomes an unwieldy `IN (...)`.
const FEED_CREATOR_LIMIT = 200;

// Which board backs each (entity, domain) pair. Red gets its own board because a
// SFW-scored board misrepresents creators whose traction is on mature content;
// green/blue share the SFW board. An unresolved domain falls back to SFW.
//
// `domain` MUST come from `getRequestBoardDomainColor`, not `getRequestDomainColor`:
// the latter never returns `red` in production (civitai.red is configured as both
// blue and red, and the color walk hits blue first), which would silently pin every
// host to the SFW board.
const BOARD_IDS: Record<NewCreatorEntity, { sfw: string; red: string }> = {
  images: { sfw: 'images-new', red: 'images-new-red' },
  models: { sfw: 'new_creators', red: 'new_creators-red' },
};

export function getNewCreatorBoardId(entity: NewCreatorEntity, domain?: DomainColor) {
  const ids = BOARD_IDS[entity];
  return domain === DomainColor.red ? ids.red : ids.sfw;
}

/**
 * User ids currently on a "new & upcoming" board.
 *
 * Resolved server-side from a board id rather than accepted from the client: an
 * endpoint that takes an arbitrary userId array is a general-purpose
 * "content from these N users" filter, which is not what we're shipping.
 *
 * Reads the most recent COMPLETE date rather than the newest one. `prepare-leaderboard`
 * inserts in batches, so the newest date can be half-written for the duration of a run;
 * taking it unconditionally would pin a truncated creator list for the whole cache TTL.
 * A date is considered complete once it holds at least the slice the feed consumes.
 */
export async function getNewCreatorUserIds({
  entity,
  domain,
}: {
  entity: NewCreatorEntity;
  domain?: DomainColor;
}): Promise<number[]> {
  const boardId = getNewCreatorBoardId(entity, domain);

  return await fetchThroughCache(
    `${REDIS_KEYS.CACHES.NEW_CREATORS}:${boardId}`,
    async () => {
      const results = await dbRead.$queryRaw<{ userId: number }[]>`
        WITH complete_date AS (
          SELECT date
          FROM "LeaderboardResult"
          WHERE "leaderboardId" = ${boardId}
          GROUP BY date
          HAVING COUNT(*) >= ${FEED_CREATOR_LIMIT}
          ORDER BY date DESC
          LIMIT 1
        )
        SELECT lr."userId"
        FROM "LeaderboardResult" lr
        WHERE lr."leaderboardId" = ${boardId}
          AND lr.date = (SELECT date FROM complete_date)
        ORDER BY lr.position
        LIMIT ${FEED_CREATOR_LIMIT}
      `;

      return results.map((r) => r.userId);
    },
    { ttl: CacheTTL.hour }
  );
}
