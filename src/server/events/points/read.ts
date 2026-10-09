import {
  eventPointKeys,
  eventPointSeason,
  eventSeasonKeys,
  hatField,
  liveBucket,
  LIVE_BUCKET_MS,
  parseHatField,
  type TotalScope,
} from '~/server/events/points/keys';
import type { EventHat } from '~/server/events/points/types';
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

export async function readTotals(
  event: PointsEvent,
  scope: TotalScope,
  fields: string[],
  now: Date,
  redis: PointsReadRedis = sysRedis
) {
  if (!fields.length) return {} as Record<string, number>;
  const keys = eventSeasonKeys(event.name, eventPointSeason(event.startDate, now));
  // The referee replaces the base and moves the cut together. Read the cut on both sides of the sums
  // and retry once if it moved, so a read never pairs the new base with the old cut's buckets.
  for (let attempt = 0; ; attempt++) {
    const cut = Number((await redis.get(keys.cut)) ?? 0);
    const sources = [
      keys.base(scope),
      ...liveBucketRange(cut, now).map((b) => keys.live(b, scope)),
    ];
    const values = await Promise.all(sources.map((key) => redis.hmGet(key, fields)));
    const cutAfter = Number((await redis.get(keys.cut)) ?? 0);
    if (cutAfter !== cut && attempt === 0) continue;
    const totals: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const row of values)
      row.forEach((value, i) => {
        if (value) totals[fields[i]] += Number(value) || 0;
      });
    return totals;
  }
}

// Live points per hat, keyed by hatField.
export function getHatPoints(event: PointsEvent, hats: Omit<EventHat, 'team'>[], now = new Date()) {
  return readTotals(event, 'hat', [...new Set(hats.map(hatField))], now);
}

export function getTeamPoints(event: PointsEvent & { teams: readonly string[] }, now = new Date()) {
  return readTotals(event, 'team', [...event.teams], now);
}

export function getOwnerPoints(event: PointsEvent, ownerIds: number[], now = new Date()) {
  return readTotals(event, 'owner', ownerIds.map(String), now);
}

// Takes up to `max` hats whose total moved since the last call, for the signals ticker.
export async function drainChangedHats(event: { name: string }, max: number) {
  const fields = await sysRedis.sPop(eventPointKeys(event.name).changed, max);
  return (Array.isArray(fields) ? fields : [fields])
    .map((field) => (typeof field === 'string' ? parseHatField(field) : undefined))
    .filter((hat): hat is Omit<EventHat, 'team'> => !!hat);
}
