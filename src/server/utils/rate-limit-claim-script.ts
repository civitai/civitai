/**
 * The atomic rate-limit claim: one EVAL that reads a bucket's attempts, decides against every rule,
 * and appends the attempt when admitted, so concurrent calls on one bucket cannot pass the limit
 * together. The window rule is the same as `evaluateRateLimitWindow` (an attempt counts while it is
 * newer than `now - windowMs`; refused once `used >= limit`), pinned by the differential test.
 *
 * The field holds a msgpack array of epoch ms, the format the JS writer used (`pack` from
 * msgpackr): msgpackr wrote float64, `cmsgpack.pack` writes integers (int64 above 2^32), and the
 * readers decode both (`toAttempts`). Loops only, no `unpack()`: it fails past ~8000 values.
 *
 * KEYS[1] = the bucket's hash. ARGV:
 *   claim:  'claim', field, now, ttlMs, keepMs, local attempts ('' or comma list), then
 *           (limit, windowMs) pairs. Reply {1} admitted (plus the stored list when local attempts
 *           were merged), or {0, list...} refused, with the stored list. Writes only on admit.
 *   refund: 'refund', field, ts, ttlMs. Removes one occurrence of ts. Reply 1, or 0 if absent.
 */
export const RATE_LIMIT_CLAIM_SCRIPT = `
local field = ARGV[2]
local raw = redis.call('HGET', KEYS[1], field)
local list = {}
if raw then
  local decoded = cmsgpack.unpack(raw)
  if type(decoded) == 'table' then list = decoded end
end

if ARGV[1] == 'refund' then
  local ts = tonumber(ARGV[3])
  local out = {}
  local removed = false
  for i = 1, #list do
    if not removed and list[i] == ts then removed = true else out[#out + 1] = list[i] end
  end
  if not removed then return 0 end
  redis.call('HSET', KEYS[1], field, cmsgpack.pack(out))
  redis.call('HPEXPIRE', KEYS[1], ARGV[4], 'FIELDS', '1', field)
  return 1
end

local now = tonumber(ARGV[3])
local keepMs = tonumber(ARGV[5])

-- Local attempts merge by multiplicity, as mergeAttempts: a value counts as often as in
-- whichever view holds it more often.
local counts = {}
for i = 1, #list do counts[list[i]] = (counts[list[i]] or 0) + 1 end
local seen = {}
local hasLocal = false
for x in string.gmatch(ARGV[6], '[^,]+') do
  hasLocal = true
  local v = tonumber(x)
  seen[v] = (seen[v] or 0) + 1
  if seen[v] > (counts[v] or 0) then list[#list + 1] = v end
end

local kept = {}
for i = 1, #list do
  if list[i] > now - keepMs then kept[#kept + 1] = list[i] end
end
table.sort(kept)

for i = 7, #ARGV, 2 do
  local limit = tonumber(ARGV[i])
  local windowMs = tonumber(ARGV[i + 1])
  local used = 0
  for j = 1, #kept do
    if kept[j] > now - windowMs then used = used + 1 end
  end
  if used >= limit then
    local reply = { 0 }
    for j = 1, #kept do reply[#reply + 1] = kept[j] end
    return reply
  end
end

kept[#kept + 1] = now
redis.call('HSET', KEYS[1], field, cmsgpack.pack(kept))
redis.call('HPEXPIRE', KEYS[1], ARGV[4], 'FIELDS', '1', field)
if not hasLocal then return { 1 } end
local reply = { 1 }
for j = 1, #kept do reply[#reply + 1] = kept[j] end
return reply
`;

export type ClaimRule = { limit: number; windowMs: number };

export function claimScriptArgs({
  field,
  now,
  ttlMs,
  keepMs,
  local,
  rules,
}: {
  field: string;
  now: number;
  ttlMs: number;
  keepMs: number;
  local: readonly number[];
  rules: readonly ClaimRule[];
}) {
  return [
    'claim',
    field,
    String(now),
    String(ttlMs),
    String(keepMs),
    local.join(','),
    ...rules.flatMap((r) => [String(r.limit), String(r.windowMs)]),
  ];
}

export const refundScriptArgs = (field: string, ts: number, ttlMs: number) => [
  'refund',
  field,
  String(ts),
  String(ttlMs),
];

/** The script's claim reply: admitted, with the stored list when it returned one. */
export function parseClaimReply(reply: unknown): { admitted: boolean; attempts?: number[] } {
  if (!Array.isArray(reply) || reply.length === 0) throw new Error('rate-limit claim: bad reply');
  const [flag, ...rest] = reply.map(Number);
  if (flag !== 0 && flag !== 1) throw new Error('rate-limit claim: bad reply');
  return flag === 1 && rest.length === 0
    ? { admitted: true }
    : { admitted: flag === 1, attempts: rest };
}
