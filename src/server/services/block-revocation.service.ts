import { redis, REDIS_KEYS } from '~/server/redis/client';

// 15 minutes, which covers an ordinary block token but NOT the worst case — App
// Blocks dev:live tokens live up to DEV_TOKEN_LIFETIME_SECONDS (4h, see
// block-token.service.ts), so a marker can lapse while such a token is still
// valid. The write path is wired: `revokeInstance` on uninstall and on
// `toggleEnabled(false)`, `clearInstance` on re-enable (block-registry.service).
// Two things still to settle before this TTL is raised to cover that worst case:
// dev page tokens share the `page_<appBlockId>` instance-id shape with prod page
// mints (see the note in api/v1/blocks/dev-token.ts), so a longer-lived dev
// revocation would reach production page tokens for the same app.
const REVOCATION_TTL_SECONDS = 900;

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
