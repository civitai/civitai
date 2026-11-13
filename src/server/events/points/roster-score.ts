import { MINUTE_MS, type RosterSort } from '~/shared/utils/roster-order';

// A roster sort's whole key packed into one sorted-set score, so Redis pages in the same order the
// page and the client rank by (roster-order.ts), across page boundaries. Every field is a whole
// number and the sum stays below 2^53, so a score is exact as a double and ZINCRBY adds to it
// exactly. Ties left after the key fall to the member string, as Redis orders them.
//
//   hats:   hats(8)   | points(27) | joinMinute(18)
//   points: points(27) | hats(8)   | joinMinute(18)
//   newest: joinMinute(18) | points(27)
//
// Sizing (prod, 2026-10): 156 event hats exist, so 8 bits always hold a count. The busiest entity
// drew about 7.5k signed-in viewers a day and each actor is capped at 50 points per owner per day,
// so a realistic owner season stays under 2^24; 2^27 is about 134M. Join minutes cover 91 days either
// side of the event start.
export const HAT_BITS = 8;
export const POINT_BITS = 27;
export const JOIN_BITS = 18;
export const MAX_HATS = 2 ** HAT_BITS - 1;
export const MAX_POINTS = 2 ** POINT_BITS - 1;
const MAX_JOIN = 2 ** JOIN_BITS - 1;
const JOIN_HALF_RANGE_MS = 2 ** (JOIN_BITS - 1) * MINUTE_MS;

// What one point adds to each sort's score: the award's increment per sort.
export const POINT_STEP: Record<RosterSort, number> = {
  hats: 2 ** JOIN_BITS,
  points: 2 ** (HAT_BITS + JOIN_BITS),
  newest: 1,
};

export type RosterStanding = { hats: number; points: number; joinMinute: number };

const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));

/** Minutes since the event's join base (91 days before its start), within the field's range. */
export function joinMinute(joinedAt: Date, startDate: Date) {
  const base = startDate.getTime() - JOIN_HALF_RANGE_MS;
  return clamp((joinedAt.getTime() - base) / MINUTE_MS, MAX_JOIN);
}

export function joinDate(minute: number, startDate: Date) {
  return new Date(startDate.getTime() - JOIN_HALF_RANGE_MS + minute * MINUTE_MS);
}

export function packStanding(sort: RosterSort, standing: RosterStanding) {
  const hats = clamp(standing.hats, MAX_HATS);
  const points = clamp(standing.points, MAX_POINTS);
  const join = clamp(standing.joinMinute, MAX_JOIN);
  if (sort === 'hats') return (hats * 2 ** POINT_BITS + points) * 2 ** JOIN_BITS + join;
  if (sort === 'points') return (points * 2 ** HAT_BITS + hats) * 2 ** JOIN_BITS + join;
  return join * 2 ** POINT_BITS + points;
}

/**
 * The standing a points-sort score holds: the one score with all three fields. `overflow` is set
 * when award increments carried points past their field, which shows here as a score past 2^53 or a
 * points field past MAX_POINTS.
 */
export function unpackPointsScore(score: number) {
  const join = score % 2 ** JOIN_BITS;
  const rest = Math.floor(score / 2 ** JOIN_BITS);
  const hats = rest % 2 ** HAT_BITS;
  const points = Math.floor(rest / 2 ** HAT_BITS);
  return {
    standing: { hats, points, joinMinute: join },
    overflow: !Number.isSafeInteger(score) || points > MAX_POINTS,
  };
}

// Writes one member's three packed scores for one season in one step, so an award increment lands
// either before or after it, never between. ARGV: member, hats, joinMinute, points. An empty points
// keeps what the points-sort score already holds (0 when absent): a later season's points are the
// award's, and a sync only refreshes its hats and join time. Lua numbers are doubles, so every field
// here is a whole number below 2^53 and %.0f writes it exactly.
export const WRITE_STANDING = `local member, hats, join = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local points = tonumber(ARGV[4])
if not points then
  local s = tonumber(redis.call('ZSCORE', KEYS[2], member) or '0')
  points = math.floor(s / ${2 ** (HAT_BITS + JOIN_BITS)})
  if points > ${MAX_POINTS} then points = ${MAX_POINTS} end
end
local h = (hats * ${2 ** POINT_BITS} + points) * ${2 ** JOIN_BITS} + join
local p = (points * ${2 ** HAT_BITS} + hats) * ${2 ** JOIN_BITS} + join
local n = join * ${2 ** POINT_BITS} + points
redis.call('ZADD', KEYS[1], string.format('%.0f', h), member)
redis.call('ZADD', KEYS[2], string.format('%.0f', p), member)
redis.call('ZADD', KEYS[3], string.format('%.0f', n), member)
return 1`;
