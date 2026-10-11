import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { EventPointSeason } from '~/server/events/points/keys';

// A team's roster: the members who chose to be listed, sortable by hats, points and join date. All
// of it in sysRedis, so a page reads no Postgres. Written by roster-sync.ts (opt-in, opt-out, a hat
// gained, a change to the member's standing, the hourly reconcile) and by the award, which only adds
// to points already there.
//
// `members` is the gate: a userId is in it only while that person is opted in, joined and eligible.
// Every read drops a row whose userId it does not name for that team, so a score left behind in a
// sorted set can never surface a hidden member.
export const ROSTER_SORTS = ['hats', 'points', 'newest'] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];
export const ROSTER_PAGE_MAX = 48;

export function eventRosterKeys(event: string) {
  const root = `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.ROSTER}` as const;
  return {
    // userId -> team, for every listed member
    members: `${root}:members` as const,
    // userId -> JSON array of the member's RosterHats, in shelf order
    hatList: `${root}:hat-list` as const,
    // owner topic id (keys.ts seasonOwnerTopicId) -> userId, for every listed member and season
    topics: `${root}:topics` as const,
    // per team: userId scored by join time (ms)
    joined: (team: string) => `${root}:${team}:joined` as const,
    // per team: userId scored by how many event hats they hold
    hats: (team: string) => `${root}:${team}:hats` as const,
    // per team and season: userId scored by the owner's points
    points: (team: string, season: EventPointSeason) => `${root}:${team}:points:${season}` as const,
  } as const;
}

export type RosterRedis = Pick<
  typeof sysRedis,
  'zRangeWithScores' | 'zCard' | 'zmScore' | 'hmGet' | 'zAddIncr'
>;

// One hat a member holds, as the card shows it: whether it is on their content now, and its shop
// price (null for the free join hat) for the card to rank by. A hat list is in shelf order: worn
// first, then dearest, then newest.
export type RosterHat = { id: number; worn: boolean; price: number | null };

export type RosterRow = {
  userId: number;
  hats: RosterHat[];
  hatCount: number;
  points: number;
  joinedAt: Date;
};

function sortKey(
  keys: ReturnType<typeof eventRosterKeys>,
  team: string,
  sort: RosterSort,
  season: EventPointSeason
) {
  if (sort === 'hats') return keys.hats(team);
  if (sort === 'points') return keys.points(team, season);
  return keys.joined(team);
}

function parseHats(value: string | null | undefined): RosterHat[] {
  if (!value) return [];
  try {
    const hats = JSON.parse(value) as unknown;
    if (!Array.isArray(hats)) return [];
    return hats.flatMap((h) => {
      const { id, worn, price } = (h ?? {}) as Record<string, unknown>;
      if (!Number.isInteger(id)) return [];
      return [
        {
          id: id as number,
          worn: worn === true,
          price: typeof price === 'number' && Number.isFinite(price) ? price : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

// One page of a team's roster, highest first. `total` is the sorted set's size, so it can count a
// row the gate then drops; a page can come back shorter than `limit` for the same reason.
export async function readRosterPage(
  {
    event,
    team,
    sort,
    season,
    offset,
    limit,
  }: {
    event: string;
    team: string;
    sort: RosterSort;
    season: EventPointSeason;
    offset: number;
    limit: number;
  },
  redis: RosterRedis = sysRedis
) {
  const keys = eventRosterKeys(event);
  const take = Math.max(1, Math.min(limit, ROSTER_PAGE_MAX));
  const from = Math.max(0, offset);
  const [rows, total] = await Promise.all([
    redis.zRangeWithScores(sortKey(keys, team, sort, season), from, from + take - 1, { REV: true }),
    redis.zCard(sortKey(keys, team, sort, season)),
  ]);
  const ids = rows.map((r) => r.value);
  if (!ids.length) return { rows: [] as RosterRow[], total: Number(total), nextOffset: undefined };

  const [teams, hatLists, hatCounts, points, joined] = await Promise.all([
    redis.hmGet(keys.members, ids),
    redis.hmGet(keys.hatList, ids),
    redis.zmScore(keys.hats(team), ids),
    redis.zmScore(keys.points(team, season), ids),
    redis.zmScore(keys.joined(team), ids),
  ]);
  const listed: RosterRow[] = [];
  ids.forEach((id, i) => {
    if (gateTeam(teams[i]) !== team) return;
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) return;
    listed.push({
      userId,
      hats: parseHats(hatLists[i]),
      hatCount: Number(hatCounts[i] ?? 0),
      points: Number(points[i] ?? 0),
      joinedAt: new Date(Number(joined[i] ?? 0)),
    });
  });
  const nextOffset = from + rows.length < Number(total) ? from + rows.length : undefined;
  return { rows: listed, total: Number(total), nextOffset };
}

// Adds a grant to the owner's roster points. XX: only a member already listed is touched, so the
// award never needs to know who opted in and can never list anyone. Returns the new score, or null
// when the owner is not listed.
export function addRosterPoints(
  redis: Pick<RosterRedis, 'zAddIncr'>,
  event: string,
  team: string,
  season: EventPointSeason,
  ownerId: number,
  grant: number
) {
  return redis.zAddIncr(
    eventRosterKeys(event).points(team, season),
    { score: grant, value: String(ownerId) },
    { condition: 'XX' }
  );
}

// The listed members among these owner topic ids: for the pusher and the interest set, which must
// never serve someone who has left the roster. The topic map only names the owner; the gate decides,
// so a topic entry a failed unlisting left behind serves nobody. Two reads.
export async function listedOwnerTopics(
  event: string,
  topicIds: string[],
  redis: Pick<RosterRedis, 'hmGet'> = sysRedis
) {
  const listed = new Map<string, number>();
  if (!topicIds.length) return listed;
  const keys = eventRosterKeys(event);
  const owners = await redis.hmGet(keys.topics, topicIds);
  const named = topicIds.flatMap((topicId, i) => {
    const ownerId = Number(owners[i]);
    return owners[i] && Number.isInteger(ownerId) && ownerId > 0 ? [{ topicId, ownerId }] : [];
  });
  if (!named.length) return listed;
  const gate = await redis.hmGet(
    keys.members,
    named.map((n) => String(n.ownerId))
  );
  named.forEach(({ topicId, ownerId }, i) => {
    if (gateTeam(gate[i])) listed.set(topicId, ownerId);
  });
  return listed;
}
// The gate's tombstone prefix (roster-sync.ts): a member hidden, not a team.
export const TOMBSTONE_PREFIX = 'x:';
// A listed gate value is the team plus a per-write suffix (roster-sync.ts), so a gate that goes
// team -> tombstone -> same team still reads as changed to a sync that read the first one.
export const LISTED_SEPARATOR = '#';
// The team a gate value lists, or null for a tombstone or nothing.
export const gateTeam = (value: string | null | undefined) =>
  value && !value.startsWith(TOMBSTONE_PREFIX) ? value.split(LISTED_SEPARATOR)[0] || null : null;
