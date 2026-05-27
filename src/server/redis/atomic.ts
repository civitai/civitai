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
    arguments: [field, value as unknown as string, String(ttlMs)],
  });
}

/**
 * Atomically set MULTIPLE hash fields' values AND a shared TTL on each
 * field. One round trip, one EVAL.
 *
 * Used by session-invalidation.ts to mark a batch of token-IDs as
 * 'invalid' / 'refresh' with the same DEFAULT_EXPIRATION TTL.
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
    ...entries.map(([, v]) => v as unknown as string),
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
