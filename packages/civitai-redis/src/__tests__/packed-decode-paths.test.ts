import { pack, unpack } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import {
  PACKED_BROTLI_SENTINEL,
  compressPacked,
  decompressPacked,
} from '../packed-compression';

/**
 * Regression guard for the hardened decode design (PR #2649 review Fix 1).
 *
 * `redis.packed` has TWO decode paths in src/server/redis/client.ts:
 *
 *   GENERAL  (safeUnpack, used by get/mGet/sMembers/sPop/hGet/hGetAll/hmGet across ~30
 *            cache writers): plain `unpack(value)` — NEVER decompresses.
 *   COMPRESS-AWARE (safeUnpackCompressed, used ONLY by get(key, { compress: true }), i.e.
 *            fetchThroughCache's compressed callers): sentinel-detect → brotli-decompress
 *            → unpack, back-compat with legacy uncompressed wrappers.
 *
 * The brotli sentinel (0x01) collides with `pack(1)` (=== <01>). Routing decompression
 * through the SHARED general path would mis-read a bare `1` (a count/flag/scalar tRPC
 * result) as a compressed payload → throw → evict → permanent cache miss. Confining
 * decompression to the compress-aware path makes the collision harmless: that path only
 * ever sees the `{ data, cachedAt }` wrapper (first byte = MAP marker, never 0x01).
 *
 * These tests model BOTH paths at the exact decode boundary the wrappers use (the same
 * `unpack` / `decompressPacked` calls as client.ts), without booting the full client
 * module (which opens TCP sockets at import).
 */

// Mirrors safeUnpack in client.ts verbatim (the GENERAL path: plain unpack, no decompress).
function safeUnpack<T>(value: Buffer): T | null {
  try {
    return unpack(value) as T;
  } catch {
    return null;
  }
}

// Mirrors safeUnpackCompressed in client.ts (the COMPRESS-AWARE path: sentinel-detect →
// decompress → unpack, evict-on-throw → null).
async function safeUnpackCompressed<T>(value: Buffer): Promise<T | null> {
  try {
    return unpack(await decompressPacked(value)) as T;
  } catch {
    return null;
  }
}

describe('packed decode paths (Fix 1 — confined decompression)', () => {
  describe('GENERAL path is collision-safe (the Fix 1 regression guard)', () => {
    it('a bare integer 1 round-trips as 1, NOT mistaken for a compressed payload', () => {
      const stored = Buffer.from(pack(1)); // === <01>, collides with the brotli sentinel
      expect(stored[0]).toBe(PACKED_BROTLI_SENTINEL);

      // The general decode path must return the integer 1, never throw / null.
      expect(safeUnpack<number>(stored)).toBe(1);
    });

    it('a bare integer 0 round-trips as 0 on the general path', () => {
      const stored = Buffer.from(pack(0));
      expect(safeUnpack<number>(stored)).toBe(0);
    });

    it('the general path never invokes brotli-decompress for a sentinel-byte scalar', () => {
      // Proven structurally: safeUnpack calls unpack(value) directly with no decompress
      // step. A bare `1` (<01>) is NOT a valid brotli stream — if it WERE routed through
      // decompressPacked it would throw. Confirm the general path returns 1 regardless.
      const one = Buffer.from(pack(1));
      expect(safeUnpack<number>(one)).toBe(1);
      // And confirm that feeding the same byte to the compress-aware decompress WOULD
      // fail (so the only thing keeping bare-1 readable is the path confinement).
      return expect(decompressPacked(one)).rejects.toThrow();
    });
  });

  describe('COMPRESS-AWARE path: compressed round-trip + legacy back-compat', () => {
    const wrapper = {
      data: {
        format: 'SafeTensor',
        tensorCount: 2,
        tensors: Array.from({ length: 50 }, (_, i) => ({ name: `blocks.${i}.weight` })),
      },
      cachedAt: 1_700_000_000_000,
    };

    it('round-trips a compressed wrapper', async () => {
      const compressed = await compressPacked(Buffer.from(pack(wrapper)));
      expect(compressed[0]).toBe(PACKED_BROTLI_SENTINEL);
      expect(await safeUnpackCompressed(compressed)).toEqual(wrapper);
    });

    it('reads a LEGACY uncompressed wrapper (no sentinel) — back-compat', async () => {
      const legacy = Buffer.from(pack(wrapper)); // pre-compression key
      expect(legacy[0]).not.toBe(PACKED_BROTLI_SENTINEL); // MAP marker
      expect(await safeUnpackCompressed(legacy)).toEqual(wrapper);
    });

    it('a corrupt/garbage value is treated as a cache miss (null), preserving fail-open', async () => {
      const garbage = Buffer.concat([Buffer.from([PACKED_BROTLI_SENTINEL]), Buffer.from('not-brotli')]);
      expect(await safeUnpackCompressed(garbage)).toBeNull();
    });
  });

  /**
   * MIXED-FLEET CANARY NOTE (expected/safe, not a bug):
   *
   * During a rollout, an OLD pod (no compress-aware read) can read a NEW compressed
   * tensor-metadata value written by a NEW pod. The old pod's safeUnpack does plain
   * `unpack(<01...>)` → msgpack throws on the brotli stream → safeUnpack evicts the key
   * and returns null (cache miss) → the request refetches uncompressed from origin and
   * repopulates. Net effect: a few transient cache misses while the fleet converges, NO
   * data corruption and NO 500s (the read is fail-open). This is the intended back-compat
   * behavior of the sentinel design, exercised here for documentation.
   */
  it('mixed-fleet: an OLD pod (general path) treats a NEW compressed value as a miss, not a crash', async () => {
    const compressed = await compressPacked(Buffer.from(pack({ data: { x: 1 }, cachedAt: 0 })));
    // The OLD pod uses the general path (no decompress) → unpack of the brotli stream throws
    // → safeUnpack returns null (caller evicts + refetches). No throw escapes, no corruption.
    expect(safeUnpack(compressed)).toBeNull();
  });
});
