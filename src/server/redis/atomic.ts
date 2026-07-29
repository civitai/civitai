/**
 * Atomic hash-field write helpers — set value AND TTL on a hash field in a
 * single server-side operation.
 *
 * Background
 * ──────────
 * `Promise.all([client.hSet(...), client.hExpire(...)])` — and the equivalent
 * sequential `await hSet; await hExpire` — leaves no-TTL hash fields *even on a
 * healthy Redis server*. The two commands are independent RESP frames, and
 * Redis does not order command admission across them. If HEXPIRE arrives at
 * the server before HSET, HEXPIRE finds the field missing and returns 0
 * silently (no rejection). Then HSET writes the field with no TTL. Result: a
 * field that should expire never does.
 *
 * Worst-case site at audit time was `src/server/oauth/model.ts` —
 * OAuth authorization codes leaking with no TTL — which is a security
 * finding (codes are intended to be single-use and short-lived; persisting
 * them indefinitely widens the replay window if the underlying hash is read).
 *
 * Other observed accumulation: per-user USER_TOKENS hashes growing
 * orphaned entries during sysRedis partial flaps (see token-refresh.ts).
 *
 * Solution
 * ────────
 * Single EVAL — Redis evaluates the Lua script atomically; HSET and
 * HPEXPIRE run in order with no other command interleaved on the key.
 * Uses HPEXPIRE for millisecond precision; supported on Redis 7.4+
 * (sysRedis is currently 7.4.5).
 *
 * Atomicity caveat
 * ────────────────
 * "Atomic on the Redis server" means no other client command can
 * interleave between the HSET and the HPEXPIRE — which is the race we
 * cared about. It does NOT mean the script is all-or-nothing in the
 * transactional sense: the two `redis.call` sites are independent. If
 * HPEXPIRE raises a Lua-level error (arg-validation, KEYS mismatch in
 * cluster mode, unsupported field type), the script aborts but HSET has
 * already mutated state and is NOT rolled back. Net result of that
 * failure class is "field set, no TTL" — the same failure mode as the
 * racy pair, minus the race window. This is still strictly better than
 * `Promise.all([hSet, hExpire])` (we eliminate the ordering race, the
 * partial-failure-on-network-blip, and the no-op silent HEXPIRE) but
 * callers should understand the residual risk and keep their fail-open
 * try/catch wrappers in place.
 *
 * Plain EVAL is intentional over `defineScript` / EVALSHA — Redis caches
 * recent scripts and re-compilation cost is negligible at our QPS.
 * Avoiding the cluster-aware SHA cache also dodges a class of NOSCRIPT
 * edge cases on cluster topology changes (sysRedis itself is single-node,
 * but this helper accepts any RedisClientType so the cache client can
 * also use it).
 *
 * Idempotency
 * ───────────
 * If the field already exists, HSET overwrites the value and HPEXPIRE
 * resets the TTL — same semantics as the racy pair, minus the race.
 *
 * Failure model
 * ─────────────
 * Throws on any underlying Redis error. Existing callers wrap the racy
 * pair in `try/catch` (fail-open semantics from PR #2286); the same
 * try/catch covers this helper without change.
 */

// We accept any RedisClientType because the codebase has both `redis`
// (cache, potentially cluster) and `sysRedis` (system, single-node)
// clients, and both wrap node-redis types in a custom mapped interface.
// The `eval` method is shared on both and uniform across the v5 API.
//
// Using `any` (not `unknown`) for `client` is deliberate — node-redis v5
// has deeply parameterised generic types (modules/functions/scripts/resp/
// type-mapping) that surface no useful constraint at the call boundary.
type EvalCapableClient = {
  eval: (
    script: string,
    options: { keys: string[]; arguments: string[] }
  ) => Promise<unknown>;
};

/**
 * Atomically set a single hash field's value AND its TTL.
 *
 * Atomicity caveat: the script's HSET and HPEXPIRE are independent
 * `redis.call` sites — a Lua-level error from HPEXPIRE leaves HSET
 * applied (field set with no TTL). See the file-header docblock for
 * the full rationale. Callers must keep fail-open try/catch wrappers.
 *
 * @param client - Any RedisClientType-shaped client with `.eval(...)` (cache
 *                 or sysRedis).
 * @param key   - Hash key.
 * @param field - Hash field name.
 * @param value - String, number, or Buffer. Buffers are stringified via the
 *                 redis driver's default RESP encoding (raw bytes preserved
 *                 for msgpack-packed values).
 * @param ttlMs - Time-to-live in milliseconds.
 */
export async function hSetWithTTL(
  client: EvalCapableClient,
  key: string,
  field: string,
  value: string | number | Buffer,
  ttlMs: number
): Promise<void> {
  // Guard against PEXPIRE/HPEXPIRE-as-delete: HPEXPIRE with 0 (or negative)
  // ms REMOVES the field. A caller-side config bug (e.g. accidental negative
  // TTL) would silently destroy the field this helper just wrote.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`hSetWithTTL: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  // HPEXPIRE arg order: key ms FIELDS numfields field
  // KEYS[1]=key  ARGV[1]=field  ARGV[2]=value  ARGV[3]=ttlMs
  const script = `
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    redis.call('HPEXPIRE', KEYS[1], ARGV[3], 'FIELDS', 1, ARGV[1])
    return 1
  `;
  // node-redis v5 EVAL options take RedisArgument[] (string | Buffer). We
  // coerce numbers via String(); Buffer is passed through. We cast to
  // string[] because the EvalCapableClient shape declares string[] for
  // simplicity — at runtime node-redis accepts Buffer here too.
  await client.eval(script, {
    keys: [key],
    arguments: [field, (typeof value === 'number' ? String(value) : value) as unknown as string, String(ttlMs)],
  });
}

/**
 * Atomically set MULTIPLE hash fields' values AND a shared TTL on each
 * field. One round trip, one EVAL.
 *
 * Used by session-invalidation.ts to mark a batch of token-IDs as
 * 'invalid' / 'refresh' with the same DEFAULT_EXPIRATION TTL.
 *
 * Atomicity caveat: HSET cannot land without HPEXPIRE *attempting* to
 * land on the same hash key inside the same Lua script invocation. The
 * script's two `redis.call` sites are NOT all-or-nothing — a Lua-level
 * error from HPEXPIRE (arg-validation, KEYS mismatch in cluster mode,
 * unsupported field type) aborts the script with HSET already applied.
 * The result of that failure class is "fields set, no TTL" — equivalent
 * to the racy pair, minus the interleaving race. This is still strictly
 * better than `Promise.all([hSet, hExpire])` (no ordering race, no
 * partial-failure-on-network-blip, no silently-zero HEXPIRE on a not-yet
 * -created field), but callers must keep fail-open try/catch wrappers
 * around this helper.
 *
 * @param client - Any RedisClientType-shaped client with `.eval(...)`.
 * @param key    - Hash key.
 * @param fields - Record of field-name -> value. Each value can be string,
 *                 number, or Buffer (use Buffer for msgpack-packed values).
 * @param ttlMs  - Time-to-live in milliseconds applied to every listed field.
 */
export async function hSetMultiWithTTL(
  client: EvalCapableClient,
  key: string,
  fields: Record<string, string | number | Buffer>,
  ttlMs: number
): Promise<void> {
  // See hSetWithTTL — HPEXPIRE with 0/negative ms removes the field.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`hSetMultiWithTTL: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const fieldNames = entries.map(([f]) => f);
  // ARGV layout:
  //   [0]      = ttlMs
  //   [1..N]   = fields (also passed as the HPEXPIRE FIELDS list)
  //   [N+1..]  = values, in the same order
  //
  // We interleave field/value pairs for HSET via Lua table-building rather
  // than relying on Lua's # operator (which is unsafe with sparse / nil
  // tables). Explicit count via ARGV[1] (= number of fields) avoids that.
  const args: string[] = [
    String(ttlMs),
    String(entries.length),
    ...fieldNames,
    ...entries.map(([, v]) => (typeof v === 'number' ? String(v) : v) as unknown as string),
  ];

  const script = `
    local ttl = ARGV[1]
    local n = tonumber(ARGV[2])
    -- HSET key field value [field value ...]
    local hsetArgs = { KEYS[1] }
    for i = 1, n do
      hsetArgs[#hsetArgs + 1] = ARGV[2 + i]           -- field
      hsetArgs[#hsetArgs + 1] = ARGV[2 + n + i]       -- value
    end
    redis.call('HSET', unpack(hsetArgs))
    -- HPEXPIRE key ms FIELDS n field [field ...]
    local hpexpireArgs = { KEYS[1], ttl, 'FIELDS', n }
    for i = 1, n do
      hpexpireArgs[#hpexpireArgs + 1] = ARGV[2 + i]
    end
    redis.call('HPEXPIRE', unpack(hpexpireArgs))
    return 1
  `;

  await client.eval(script, {
    keys: [key],
    arguments: args,
  });
}

/**
 * Atomically add a member to a sorted set AND set the key's TTL.
 *
 * Same race-class bug as hSetWithTTL: `Promise.all([zAdd, expire])` (or
 * `await zAdd; await expire`) can land EXPIRE before ZADD on the server.
 * EXPIRE on a missing key is a no-op (returns 0), then ZADD writes the
 * member and the key has no TTL — the sorted set never expires.
 *
 * Sorted sets have key-level TTL only (no per-member TTL like hash fields'
 * HPEXPIRE), so this uses PEXPIRE on the whole key. Callers that don't
 * want a TTL (e.g. counters with `ttl === 0`) must bypass this helper and
 * call `zAdd` directly — PEXPIRE with 0ms would DELETE the key.
 *
 * Atomicity caveat: same as hSetWithTTL — ZADD and PEXPIRE are
 * independent `redis.call` sites; a Lua-level error from PEXPIRE leaves
 * ZADD applied (member added, no TTL on the key). Strictly better than
 * the racy pair, but not transactional. Keep fail-open wrappers in place.
 *
 * @param client - Any RedisClientType-shaped client with `.eval(...)`.
 * @param key    - Sorted set key.
 * @param score  - Numeric score for the member.
 * @param member - Member string.
 * @param ttlMs  - Time-to-live in milliseconds. Must be > 0.
 */
export async function zAddWithTTL(
  client: EvalCapableClient,
  key: string,
  score: number,
  member: string,
  ttlMs: number
): Promise<void> {
  // PEXPIRE with 0 (or negative) ms DELETES the key — would destroy the
  // sorted set ZADD just wrote into. Guard against caller-side config bugs.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`zAddWithTTL: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  // KEYS[1]=key  ARGV[1]=score  ARGV[2]=member  ARGV[3]=ttlMs
  const script = `
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1
  `;
  await client.eval(script, {
    keys: [key],
    arguments: [String(score), member, String(ttlMs)],
  });
}

/**
 * Atomically SADD a member to a tag-set AND ensure the set's whole-key TTL is a
 * FLOOR of `ttlSeconds` — in a single EVAL that replaces the racy, redundant
 * `Promise.all([redis.sAdd(key, member), redis.expire(key, ttlSeconds)])` pair
 * the tRPC tag-based cache used on every cache-miss write (see the `cacheIt`
 * middleware in `src/server/middleware.trpc.ts`).
 *
 * The tag-set / cache-tag model
 * ─────────────────────────────
 * A cache tag (e.g. `leaderboard-3`) owns a Redis SET whose members are the
 * cache KEYS tagged with it. A tag bust (`redis.purgeTags`) reads the set's
 * members and deletes them. So the set MUST outlive every member it holds —
 *
 *   INVARIANT:  TTL(tagSet)  ≥  max remaining TTL of any member key
 *
 * — or a later bust reads an already-expired (empty) set, misses the still-live
 * member keys, and serves STALE cache until those members expire on their own.
 *
 * Why the old pair was wrong AND wasteful
 * ───────────────────────────────────────
 *   1. WASTE: it issued a SEPARATE `EXPIRE key ttl` node-redis command on EVERY
 *      tagged cache-miss write (~2.6k/s at peak) in addition to the `SADD`.
 *   2. CORRECTNESS: that `EXPIRE` was UNCONDITIONAL and plain `EXPIRE`
 *      OVERWRITES the TTL. If a longer-TTL member had extended the set, a later
 *      shorter-TTL write would SHORTEN the set below that longer member —
 *      breaking the invariant (a bust after the set expired but before the long
 *      member does misses it → stale). This can't happen with today's
 *      all-equal-TTL callers, but the primitive was latently unsafe.
 *
 * What this helper does (one node-redis command)
 * ──────────────────────────────────────────────
 *   SADD member, read the set's TTL, and set the TTL to `ttlSeconds` ONLY when
 *   the set's current TTL is below `ttlSeconds` (which includes the freshly
 *   SADD-created no-expiry set, whose `TTL` reply is -1). It NEVER shortens a
 *   set that a longer-TTL member already extended (`cur >= ttlSeconds` → the
 *   server-side EXPIRE is skipped) — a server-side "raise-to-floor" that
 *   strictly preserves the invariant. Note this floor semantics is NOT
 *   expressible with a single native `EXPIRE` flag: `GT` treats the fresh
 *   no-expiry set as +∞ and would never give it a TTL (leak); `LT` would refuse
 *   to raise a decayed set back up to the floor. Hence the TTL read + explicit
 *   compare inside one EVAL.
 *
 * Behaviour vs. the old pair
 * ──────────────────────────
 *   For the current all-equal-TTL callers the resulting set TTL is IDENTICAL to
 *   the old unconditional EXPIRE (the set is always (re)floored to `ttlSeconds`,
 *   since a decayed or fresh set always has `cur < ttlSeconds`). Cache hits,
 *   busts, and member expiry are all unchanged. The GE guard only DIVERGES —
 *   safely, by not shortening — when a longer-TTL member ever shares the tag.
 *
 * Command reduction: the separate ~2.6k/s `EXPIRE` node-redis command is gone
 * (folded into the EVAL that already had to issue the `SADD`); the redundant
 * server-side EXPIRE is additionally skipped whenever the set's TTL is already
 * at/above the floor.
 *
 * Atomicity caveat: SADD then a conditional EXPIRE are independent `redis.call`
 * sites in one script — no other client command interleaves between them, and
 * (unlike the racy Promise.all pair) a crash cannot land SADD without the
 * EXPIRE, so the set can no longer leak as a persistent no-TTL key. A Lua-level
 * error after the SADD leaves "member added, no TTL" — the same residual class
 * as `zAddWithTTL`; callers must keep their fail-open wrappers.
 *
 * @param client     - Any RedisClientType-shaped client with `.eval(...)` (the
 *                     tRPC cache middleware passes the cache cluster client).
 * @param key        - Tag-set key (`caches:tagged-cache:<slug>`).
 * @param member     - Member to add (the tagged cache key).
 * @param ttlSeconds - TTL floor for the set, in SECONDS (matches the member
 *                     key's `EX` seconds). Must be a positive finite number.
 * @returns SADD's reply — the number of NEWLY added members (0 if `member` was
 *          already present).
 */
export async function sAddWithExpireGe(
  client: EvalCapableClient,
  key: string,
  member: string,
  ttlSeconds: number
): Promise<number> {
  // A non-positive / non-finite TTL would make the floor meaningless and, if it
  // ever reached `EXPIRE` as 0/negative, DELETE the set. Guard before the EVAL.
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      `sAddWithExpireGe: ttlSeconds must be a positive finite number, got ${ttlSeconds}`
    );
  }
  // KEYS[1]=tag set  ARGV[1]=member  ARGV[2]=ttlSeconds
  // TTL replies: -2 = key missing (impossible right after SADD), -1 = no expiry
  // (a freshly SADD-created set, or a persisted one), >=0 = seconds remaining.
  // `cur < ttl` therefore fires for the fresh set (-1) and any decayed set,
  // and is SKIPPED only when the set already outlives the floor — never
  // shortening a longer TTL a bigger member set.
  const script = `
    local added = redis.call('SADD', KEYS[1], ARGV[1])
    local ttl = tonumber(ARGV[2])
    local cur = redis.call('TTL', KEYS[1])
    if cur < ttl then
      redis.call('EXPIRE', KEYS[1], ttl)
    end
    return added
  `;
  const reply = await client.eval(script, {
    keys: [key],
    arguments: [member, String(ttlSeconds)],
  });
  return typeof reply === 'number' ? reply : Number(reply) || 0;
}
