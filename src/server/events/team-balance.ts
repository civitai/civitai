import {
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';

// Join-time team balancing. An event that opts in (`join.balance`) reads a list of users, each with
// the points they are predicted to earn, from sysRedis. A listed user joining is placed on the team
// whose listed joiners so far are predicted to earn the least, and that placement is written to the
// event's manual assignments, which getUserTeam already honours. Unlisted users keep the seeded hash.
//
// The list is data loaded by hand before the event; nothing about who is on it lives in code.
//
//   <event>:team-balance-list      userId -> predicted points (a non-negative integer)
//   <event>:team-balance-totals    team   -> sum of predicted points of listed users placed there
//   <event>:team-balance-assigned  userId -> team, for every placement this made (so an operator
//                                  can undo exactly these and none of the curators' assignments)
export function teamBalanceKeys(event: string) {
  const base = `${REDIS_SYS_KEYS.EVENT}:${event}` as const;
  return {
    manual: `${base}:${REDIS_SUB_KEYS.EVENT.MANUAL_ASSIGNMENTS}`,
    list: `${base}:${REDIS_SUB_KEYS.EVENT.TEAM_BALANCE_LIST}`,
    totals: `${base}:${REDIS_SUB_KEYS.EVENT.TEAM_BALANCE_TOTALS}`,
    assigned: `${base}:${REDIS_SUB_KEYS.EVENT.TEAM_BALANCE_ASSIGNED}`,
  } as const;
}

// One script, so reading the lightest team, adding to its total and recording the placement cannot
// interleave with another join (sysRedis is a single node, so the four keys may be touched together).
// An existing manual assignment wins and changes nothing, which also makes a repeat call for the same
// user a no-op. Ties go to the earliest team in ARGV order. Returns the team placed on, or nil for an
// unlisted user.
// KEYS: manual, list, totals, assigned. ARGV: userId, then the event's teams.
export const PLACE_LISTED_JOINER = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then return existing end
local points = redis.call('HGET', KEYS[2], ARGV[1])
if not points then return nil end
if not string.match(points, '^%d+$') then
  return redis.error_reply('team balance: points for ' .. ARGV[1] .. ' are not an integer')
end
local best = nil
local bestTotal = nil
for i = 2, #ARGV do
  local total = tonumber(redis.call('HGET', KEYS[3], ARGV[i]) or '0')
  if bestTotal == nil or total < bestTotal then
    best = ARGV[i]
    bestTotal = total
  end
end
redis.call('HINCRBY', KEYS[3], best, points)
redis.call('HSET', KEYS[1], ARGV[1], best)
redis.call('HSET', KEYS[4], ARGV[1], best)
return best
`;

// The team a listed user is placed on, or undefined for an unlisted one. Throws when sysRedis cannot
// answer: the caller refuses the join rather than hand a listed user the hashed team.
export async function placeListedJoiner(
  event: string,
  userId: number,
  teams: readonly string[]
): Promise<string | undefined> {
  const keys = teamBalanceKeys(event);
  // A timed-out call may still run later; that is safe, since a retry finds the placement it wrote.
  const team = await withSysReadDeadline(
    sysRedis.eval(PLACE_LISTED_JOINER, {
      keys: [keys.manual, keys.list, keys.totals, keys.assigned],
      arguments: [userId.toString(), ...teams],
    })
  );
  return typeof team === 'string' ? team : undefined;
}
