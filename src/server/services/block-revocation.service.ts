import { redis, REDIS_KEYS } from '~/server/redis/client';
import { MAX_BLOCK_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token-lifetimes';

// A marker shorter than the token it revokes lapses while that token is still
// accepted, and the gate reads a missing key as "not revoked" — the control
// stops refusing without failing. Same relationship key-rotation overlap states
// in block-token.service.ts; deriving it is what stops the two drifting again.
const REVOCATION_TTL_SECONDS = MAX_BLOCK_TOKEN_LIFETIME_SECONDS;

function revokedKey(blockInstanceId: string) {
  return `${REDIS_KEYS.BLOCKS.REVOKED_INSTANCE}:${blockInstanceId}` as const;
}

/**
 * Per-blockInstanceId token revocation, written when an install is
 * uninstalled, toggled off, or the publisher is banned. Tokens for the
 * revoked instance are rejected by the block-scope middleware until the
 * marker's TTL elapses.
 *
 * This is a deliberately coarse-grained revocation primitive (per-instance,
 * not per-jti). A per-jti denylist is heavier infra and gains little for v1
 * volumes — the same outcome at lower cost.
 */
export class BlockRevocation {
  static async revokeInstance(blockInstanceId: string): Promise<void> {
    try {
      await redis.set(revokedKey(blockInstanceId), '1', { EX: REVOCATION_TTL_SECONDS });
    } catch {
      // Fail open: an uninstall/toggle/ban write path must not block on a
      // Redis incident. If the marker isn't written, tokens for this
      // instance remain valid until natural exp — exposure is bounded by the
      // token lifetime rather than by Redis-recovery time. Accepted tradeoff.
    }
  }

  static async isRevoked(blockInstanceId: string): Promise<boolean> {
    try {
      const v = await redis.get<string>(revokedKey(blockInstanceId));
      return v != null;
    } catch {
      // Fail open — never block legitimate traffic on a Redis incident.
      return false;
    }
  }

  /**
   * Clears a revocation marker. Every path that brings an install back — both
   * `toggleEnabled(true)` and `installOnModel` on an existing row — must call
   * it: blockInstanceId is preserved across disable, so the marker written
   * then otherwise survives, and 403s the revived install's tokens for the
   * rest of REVOCATION_TTL_SECONDS (audit B1).
   */
  static async clearInstance(blockInstanceId: string): Promise<void> {
    try {
      await redis.del(revokedKey(blockInstanceId));
    } catch {
      // fail open
    }
  }
}
