/**
 * The HA/Sentinel `sysRedis` client (PR #2331) returns `BLOB_STRING` replies —
 * i.e. string VALUES from get/hGet/hGetAll(values)/sMembers/zRange members/lRange —
 * as Node `Buffer`s, not strings. Any string op on them then misbehaves: `.split`/
 * `.replace` throw, and `buf === 'literal'` silently takes the wrong branch. Decode
 * a read back to a utf8 string before treating it as one. No-op when the value is
 * already a string (single-node / dev) or null/undefined.
 *
 * Same coercion as the earlier per-site fixes (redis/queues.ts, image-scanner-flag.ts,
 * metrics/base.metrics.ts). Prefer this helper for new call sites.
 */
export function decodeRedisString<T extends string | null | undefined>(value: T | Buffer): T {
  return (Buffer.isBuffer(value) ? value.toString('utf8') : value) as T;
}
