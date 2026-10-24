// Atomic HSET + per-field HPEXPIRE in one EVAL, rather than a sequential hSet + hExpire: the sequential
// pair can leave a NO-TTL field in Redis if the process dies between awaits, which for the orchestrator-token
// cache would pin a token past its DB-key expiry. Per-FIELD HPEXPIRE (not whole-key EXPIRE) because the hash
// is keyed by userId — each write must expire only its own field. The @civitai/redis client doesn't surface
// `eval` in its typed facade, so we take a minimal eval-capable handle and the caller casts.

export interface EvalCapableClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/**
 * Atomically HSET a hash field AND set a per-field TTL (HPEXPIRE) in one EVAL.
 *
 * @param client - eval-capable redis handle.
 * @param key    - hash key.
 * @param field  - hash field name.
 * @param value  - string, number, or Buffer (Buffer preserves msgpack-packed bytes).
 * @param ttlMs  - time-to-live in milliseconds (must be a positive finite number).
 */
export async function hSetWithTTL(
  client: EvalCapableClient,
  key: string,
  field: string,
  value: string | number | Buffer,
  ttlMs: number
): Promise<void> {
  // Guard against HPEXPIRE-as-delete: HPEXPIRE with 0 (or negative) ms REMOVES the field, so a caller-side
  // bug (e.g. an accidental negative TTL) would silently destroy the field we just wrote.
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
  await client.eval(script, {
    keys: [key],
    // node-redis accepts Buffer here at runtime; the type says string[] for simplicity.
    arguments: [
      field,
      (typeof value === 'number' ? String(value) : value) as unknown as string,
      String(ttlMs),
    ],
  });
}
