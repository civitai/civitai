/**
 * The cache cluster's CROSSSLOT rule, for the crucible vote tests: a script or MULTI whose keys
 * are not all in one hash slot is refused.
 *
 * Interim: `rejectCrossSlot` (`src/__tests__/cluster-slots.ts`) and `keyHashSlot`
 * (`@civitai/redis/key-slot`) are added by #9532, which is not on main yet. Once it is, use those
 * and delete this file. Pinned to the same specification values in crucible-cross-slot.test.ts.
 */

/**
 * The cluster hash slot of `key` (0-16383): CRC16-XMODEM modulo 16384, hashing only the part
 * between the first `{` and the next `}` when that part is not empty (the hash tag).
 */
export function keyHashSlot(key: string): number {
  let hashed = key;
  const open = key.indexOf('{');
  if (open >= 0) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) hashed = key.slice(open + 1, close);
  }
  let crc = 0;
  for (const byte of new TextEncoder().encode(hashed)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16384;
}

/** Throws as the cache cluster answers a script or MULTI over `keys` in more than one slot. */
export function rejectCrossSlot(keys: readonly string[]) {
  if (new Set(keys.map(keyHashSlot)).size > 1)
    throw new Error(`CROSSSLOT Keys in request don't hash to the same slot: ${keys.join(' ')}`);
}
