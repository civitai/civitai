import {
  COUNT_BASE_MARK,
  countField,
  eventPointSeason,
  eventSeasonKeys,
  hatField,
  liveBucket,
  LIVE_BUCKET_MS,
  type TotalScope,
} from '~/server/events/points/keys';
import type { EventHat, EventPointType } from '~/server/events/points/types';
import { sysRedis } from '~/server/redis/client';

type PointsEvent = { name: string; startDate: Date };

// Live buckets are kept 3 hours; the referee settles hourly, so a cut older than this means it has
// stopped, and the totals shown are the base plus the buckets that still exist.
const MAX_LIVE_BUCKETS = (3 * 60 * 60 * 1000) / LIVE_BUCKET_MS;

// The live buckets a read adds on top of the base: from the referee's cut to now.
export function liveBucketRange(cut: number, now: Date) {
  const last = liveBucket(now);
  const first = Math.max(cut, last - MAX_LIVE_BUCKETS + 1);
  const buckets: number[] = [];
  for (let b = first; b <= last; b++) buckets.push(b);
  return buckets;
}

export type PointsReadRedis = Pick<typeof sysRedis, 'get' | 'hmGet'>;

// Totals for several scopes off one read of the cut, so they agree with each other.
async function readScopes<S extends TotalScope>(
  event: PointsEvent,
  request: Record<S, string[]>,
  now: Date,
  redis: PointsReadRedis
) {
  const scopes = (Object.keys(request) as S[]).filter((scope) => request[scope].length);
  const totals = Object.fromEntries(
    (Object.keys(request) as S[]).map((scope) => [scope, {} as Record<string, number>])
  ) as Record<S, Record<string, number>>;
  if (!scopes.length) return totals;
  const keys = eventSeasonKeys(event.name, eventPointSeason(event.startDate, now));
  // The referee replaces the base and moves the cut together. Read the cut on both sides of the sums
  // and retry once if it moved, so a read never pairs the new base with the old cut's buckets.
  for (let attempt = 0; ; attempt++) {
    const cut = Number((await redis.get(keys.cut)) ?? 0);
    const buckets = liveBucketRange(cut, now);
    const values = await Promise.all(
      scopes.map((scope) =>
        Promise.all(
          [keys.base(scope), ...buckets.map((b) => keys.live(b, scope))].map((key) =>
            redis.hmGet(key, request[scope])
          )
        )
      )
    );
    const cutAfter = Number((await redis.get(keys.cut)) ?? 0);
    if (cutAfter !== cut && attempt === 0) continue;
    scopes.forEach((scope, s) => {
      const fields = request[scope];
      const sums: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
      for (const row of values[s])
        row.forEach((value, i) => {
          if (value) sums[fields[i]] += Number(value) || 0;
        });
      totals[scope] = sums;
    });
    return totals;
  }
}

export async function readTotals(
  event: PointsEvent,
  scope: TotalScope,
  fields: string[],
  now: Date,
  redis: PointsReadRedis = sysRedis
) {
  return (await readScopes(event, { [scope]: fields } as Record<TotalScope, string[]>, now, redis))[
    scope
  ];
}

// The per-type counts a hat shows, named as its rows name them.
export const HAT_COUNT_FIELDS = {
  view: 'impressions',
  reaction: 'reactions',
  comment: 'comments',
  sticker: 'stickers',
  remix: 'remixes',
} as const satisfies Partial<Record<EventPointType, string>>;
export type HatCounts = Record<(typeof HAT_COUNT_FIELDS)[keyof typeof HAT_COUNT_FIELDS], number>;
const HAT_COUNT_TYPES = Object.entries(HAT_COUNT_FIELDS) as [
  keyof typeof HAT_COUNT_FIELDS,
  keyof HatCounts
][];

// Live points and counts per hat, keyed by hatField. Counts are null until the referee has written
// a count base (COUNT_BASE_MARK).
export async function getHatTotals(
  event: PointsEvent,
  hats: Omit<EventHat, 'team'>[],
  now = new Date(),
  redis: PointsReadRedis = sysRedis
) {
  const unique = [...new Map(hats.map((hat) => [hatField(hat), hat])).values()];
  const { hat: points, count } = await readScopes(
    event,
    {
      hat: unique.map(hatField),
      count: [
        COUNT_BASE_MARK,
        ...unique.flatMap((hat) => HAT_COUNT_TYPES.map(([type]) => countField(type, hat))),
      ],
    },
    now,
    redis
  );
  if (!count[COUNT_BASE_MARK]) return { points, counts: null };
  const counts: Record<string, HatCounts> = {};
  for (const hat of unique)
    counts[hatField(hat)] = Object.fromEntries(
      HAT_COUNT_TYPES.map(([type, name]) => [name, count[countField(type, hat)] ?? 0])
    ) as HatCounts;
  return { points, counts };
}

export function getTeamPoints(event: PointsEvent & { teams: readonly string[] }, now = new Date()) {
  return readTotals(event, 'team', [...event.teams], now);
}

export function getOwnerPoints(event: PointsEvent, ownerIds: number[], now = new Date()) {
  return readTotals(event, 'owner', ownerIds.map(String), now);
}
