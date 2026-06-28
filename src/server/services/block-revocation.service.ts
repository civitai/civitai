import { redis, REDIS_KEYS } from '~/server/redis/client';

// The revocation marker must outlive the WORST-CASE remaining lifetime of any
// token type at the moment of revocation, or a still-valid token could pass the
// `isRevoked` check again once the marker expires. The longest-lived token is
// the dev:live token (DEV_TOKEN_LIFETIME_SECONDS = 4h, block-token.service.ts);
// production/settings tokens (900s/300s) are far shorter and reusing the larger
// TTL is harmless (per-instance, coarse — and `clearInstance` on re-enable drops
// a stale marker immediately). Keep this >= the max token lifetime: if the dev
// lifetime ever changes, bump this in lockstep.
//
// NOTE: dev-token instances are distinct synthetic ids
// (page_<appBlockId>/page_pubreq_<id>/page_local_<slug>), so the 4h marker only
// ever lingers for those; a re-enabled production install is cleared via
// clearInstance regardless of this TTL (audit B1).
const REVOCATION_TTL_SECONDS = 4 * 60 * 60;

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
      // instance remain valid until natural exp (15 min for most scopes,
      // 5 min for settings). Exposure is bounded by the token lifetime
      // rather than by Redis-recovery time. Accepted tradeoff.
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
   * Clears a revocation marker. Called by `toggleEnabled(true)` so re-enabling
   * an install doesn't leave a stale marker that 403s every token for the
   * next 15 minutes (audit B1). blockInstanceId is preserved across toggle,
   * so the marker written on disable would otherwise survive re-enable.
   */
  static async clearInstance(blockInstanceId: string): Promise<void> {
    try {
      await redis.del(revokedKey(blockInstanceId));
    } catch {
      // fail open
    }
  }
}
