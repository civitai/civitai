import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { getEventAccess } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { REDIS_KEYS } from '~/server/redis/client';
import { cosmeticCache } from '~/server/redis/caches';
import { getWithheldCosmeticIds } from '~/server/services/creator-shop-withheld';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { isShowcaseLive, SHOWCASE_EVENT } from '~/shared/constants/showcase-hat.constants';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';

// The showcase hat: one of a player's event hats, drawn on their avatar on the surfaces that opt in
// (UserAvatar `withShowcaseHat`). Showing it makes no copy and earns nothing. The player's pick lives
// in User.settings beside the roster opt-in; with no pick (or a pick they no longer own) it is the hat
// the roster card leads with: placed first, then dearest, then newest. SHOWCASE_OFF there shows none.
// With no pick, the default shows only for a player who has placed one of the event's hats at least
// once, now or before; a joiner who never placed or picked shows none.

export { isShowcaseLive, SHOWCASE_EVENT };

export const SHOWCASE_SETTING = 'eventShowcaseHat';
export const SHOWCASE_OFF = 'off';

type QueryDb = Pick<typeof dbRead, '$queryRaw'>;

/**
 * Each user's showcase hat id, for one event. One statement for the whole batch: per user, an index
 * range on UserCosmetic (userId leads its key) over their own rows only, joined to the event's hats.
 * Users who own none of the event's hats, turned it off, or neither picked nor ever placed one get no
 * entry.
 */
export async function resolveShowcaseHatIds(
  event: string,
  userIds: number[],
  db: QueryDb = dbRead
): Promise<Map<number, number>> {
  if (!userIds.length) return new Map();
  const rows = await db.$queryRaw<{ userId: number; cosmeticId: number }[]>`
    WITH ev AS (
      SELECT id FROM "Cosmetic"
      WHERE type = 'ContentDecoration' AND data ->> 'event' = ${event}
    )
    SELECT u.id AS "userId", h."cosmeticId"
    FROM "User" u
    JOIN LATERAL (
      SELECT uc."cosmeticId"
      FROM "UserCosmetic" uc
      -- A semi-join, not a join: joined, the plan probes the key once per user per event hat.
      WHERE uc."userId" = u.id AND uc."cosmeticId" IN (SELECT id FROM ev)
      -- The roster's shelf order (roster-sync.ts), with the pick in front of it.
      ORDER BY
        uc."cosmeticId"::text IS NOT DISTINCT FROM (u.settings -> ${SHOWCASE_SETTING} ->> ${event}) DESC,
        uc."equippedToId" IS NOT NULL DESC,
        (SELECT min(si."unitAmount") FROM "CosmeticShopItem" si
          WHERE si."cosmeticId" = uc."cosmeticId") DESC NULLS LAST,
        uc."obtainedAt" DESC, uc."cosmeticId"
      LIMIT 1
    ) h ON true
    WHERE u.id = ANY(${userIds}::int[])
      AND (u.settings -> ${SHOWCASE_SETTING} ->> ${event}) IS DISTINCT FROM ${SHOWCASE_OFF}
      AND (
        (u.settings -> ${SHOWCASE_SETTING} ->> ${event}) IS NOT NULL
        -- Ended placements count too, so only EventCosmeticPlacement_userId_event_idx answers this.
        OR EXISTS (
          SELECT 1 FROM "EventCosmeticPlacement" p
          WHERE p."userId" = u.id AND p.event = ${event}
        )
      )
  `;
  return new Map(rows.map((r) => [r.userId, r.cosmeticId]));
}

type ShowcaseHatLookup = { userId: number; cosmeticId: number };

// Per user, filled on a miss only, one resolve per batch of missed ids. Outside the event window the
// lookup reads nothing. Refreshed on a pick and on any hat write (syncEventRosterMembers), so the TTL
// is only the backstop.
export const showcaseHatCache = createCachedObject<ShowcaseHatLookup>({
  key: REDIS_KEYS.CACHES.SHOWCASE_HAT,
  idKey: 'userId',
  staleWhileRevalidate: false,
  ttl: CacheTTL.hour,
  lookupFn: async (ids, fromWrite) => {
    if (!isShowcaseLive() || !ids.length) return {};
    const db = fromWrite ? dbWrite : dbRead;
    const resolved = await resolveShowcaseHatIds(SHOWCASE_EVENT.name, ids, db);
    // A withheld hat shows on no one; checked here so a read never queries for it.
    const withheld = await getWithheldCosmeticIds([...new Set(resolved.values())], db);
    return Object.fromEntries(
      [...resolved]
        .filter(([, cosmeticId]) => !withheld.has(cosmeticId))
        .map(([userId, cosmeticId]) => [userId, { userId, cosmeticId }])
    );
  },
});

/** Re-reads these users' showcase hats from the primary. Never throws: it follows a committed write. */
export async function refreshShowcaseHats(userIds: number[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length || !isShowcaseLive()) return;
  for (let i = 0; i < ids.length; i += 500)
    await showcaseHatCache.refresh(ids.slice(i, i + 500)).catch(() => undefined);
}

/** What an avatar draws. `until` is the event's end, so a cached copy stops showing on time. */
export type ShowcaseHat = {
  cosmeticId: number;
  url: string;
  fit?: EventDecorationFit;
  until: string;
};

/**
 * The showcase hats of these users that are on show now. Empty outside the event window: the pick is
 * kept, but nothing is drawn after the end. Never throws: it rides on comment and creator-card
 * reads, and a failure there costs the hat, not the page.
 */
export async function getShowcaseHatsForUsers(
  userIds: number[],
  now = new Date()
): Promise<Record<number, ShowcaseHat>> {
  const ids = [...new Set(userIds)].filter((id) => id > 0);
  if (!ids.length || !isShowcaseLive(now)) return {};
  try {
    if (!(await isShowcaseOpenToEveryone(now))) return {};
    return await readShowcaseHats(ids);
  } catch {
    return {};
  }
}

// The event's flag is its kill switch. Asked for a signed-out viewer, so the answer is the same for
// every viewer: user.getCreator is edge-cached as one public response, so a per-viewer gate can't hold.
async function isShowcaseOpenToEveryone(now: Date) {
  const event = (await loadEvents()).find((e) => e.name === SHOWCASE_EVENT.name);
  return !!event && (await getEventAccess(event, null, now)) === 'open';
}

async function readShowcaseHats(ids: number[]) {
  const lookups = await showcaseHatCache.fetch(ids);
  const hatIds = [...new Set(Object.values(lookups).map((x) => x.cosmeticId))];
  if (!hatIds.length) return {};
  const cosmetics = await cosmeticCache.fetch(hatIds);
  const until = SHOWCASE_EVENT.endDate.toISOString();
  const result: Record<number, ShowcaseHat> = {};
  for (const { userId, cosmeticId } of Object.values(lookups)) {
    const data = cosmetics[cosmeticId]?.data;
    if (!isEventDecorationData(data) || data.type !== 'hat') continue;
    result[userId] = { cosmeticId, url: data.url, fit: data.fit, until };
  }
  return result;
}

export async function getShowcaseHatForUser(userId: number): Promise<ShowcaseHat | null> {
  return (await getShowcaseHatsForUsers([userId]))[userId] ?? null;
}
