/**
 * The cluster hash slot of `key` (0-16383), as the Redis cluster specification defines it:
 * CRC16-XMODEM of the key modulo 16384, where a key holding a `{...}` with at least one character
 * between the first `{` and the next `}` hashes only that part (its hash tag). The cache cluster
 * rejects a MULTI, a script or a multi-key command whose keys are not all in one slot (CROSSSLOT).
 *
 * Written out rather than taken from `cluster-key-slot`, which hashes `foo{}{bar}` (an empty first
 * tag) as `{bar` where the server hashes the whole key; tests use this to say what the server does.
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

/** The distinct slots `keys` hash to: one entry when the cluster accepts them in one command. */
export const keyHashSlots = (keys: readonly string[]): number[] => [
  ...new Set(keys.map(keyHashSlot)),
];
