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
 * Per-blockInstanceId token revocation, written when an install is uninstalled,
 * toggled off, or its publisher is banned. Tokens for the revoked instance are
 * rejected by the block-scope middleware until the marker's TTL elapses.
 *
 * 🔴 THE BAN LEG IS REAL NOW — AND THIS DOCBLOCK HAS CLAIMED IT BEFORE IT WAS.
 * It once listed "or the publisher is banned" with no such writer in the tree,
 * and was then corrected to say no ban path writes a marker. As of clawgate #618
 * a writer exists, so the correction is stale in turn. `revokeInstance` has
 * exactly THREE production call sites: `uninstallFromModel` and
 * `toggleEnabled(false)` (both `block-registry.service.ts`), and
 * `revokeBlockInstancesForPublisher`
 * (`blocks/publisher-ban-revocation.service.ts`), reached from `toggleBan`.
 * Read that writer's docblock before reasoning about the ban path: it covers
 * blocks the banned user OWNS, not ones they hold a collaborator seat on.
 *
 * This is a deliberately coarse-grained revocation primitive (per-instance,
 * not per-jti). A per-jti denylist is heavier infra and gains little for v1
 * volumes — the same outcome at lower cost.
 */
/**
 * Why a marker exists, stored AS the marker's value.
 *
 * 🔴 THIS IS A SECURITY DISTINCTION, NOT BOOKKEEPING. The marker used to be one
 * opaque bit with three writers and two clearers, and `clearInstance` is reachable by
 * the install's CONSUMER — `toggleEnabled(true)` and `installOnModel` on an existing
 * row both call it, and `blockInstanceId` survives a disable. So an ordinary,
 * un-banned model owner toggling a banned publisher's install off and on again
 * cleared the BAN's marker and put the publisher's tokens straight back into service.
 * Recording the cause is what lets `clearInstance` refuse that one case while staying
 * unconditional for the case it was written for.
 *
 * The legacy value `'1'` predates this and is treated as `install` — correct, because
 * every marker written before the ban writer existed came from an uninstall or a
 * toggle-off.
 */
const REVOCATION_CAUSES = ['install', 'ban'] as const;
export type RevocationCause = (typeof REVOCATION_CAUSES)[number];

export class BlockRevocation {
  static async revokeInstance(
    blockInstanceId: string,
    opts: { cause?: RevocationCause } = {}
  ): Promise<void> {
    try {
      await redis.set(revokedKey(blockInstanceId), opts.cause ?? 'install', {
        EX: REVOCATION_TTL_SECONDS,
      });
    } catch {
      // Fail open: an uninstall/toggle write path must not block on a
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
   *
   * 🔴 EXCEPT A `ban` MARKER, WHICH IT REFUSES TO CLEAR. Both callers are reachable
   * by the install's CONSUMER — a model owner, who is a different and un-banned
   * account — so without this check, toggling a banned publisher's install off and on
   * again undoes the moderation action. Lifting the ban is deliberately NOT a clear
   * path either: the markers expire after one token lifetime and re-minting is the
   * recovery, which is the same posture `toggleBan`'s unban branch takes.
   *
   * Costs one extra `GET` on the re-enable path, which is rare and un-hot.
   *
   * 🔴 FAILS CLOSED ON A READ ERROR — the opposite of `isRevoked`, on purpose. Here
   * the two directions are not symmetric: an un-cleared marker expires on its own
   * within one token lifetime, while a wrongly-cleared ban marker is unrecoverable
   * without a second moderator action. `isRevoked`'s fail-OPEN is about not refusing
   * live traffic during a Redis incident and is untouched by this.
   */
  static async clearInstance(blockInstanceId: string): Promise<void> {
    const key = revokedKey(blockInstanceId);
    try {
      const cause = await redis.get<string>(key);
      if (cause === 'ban') return;
      await redis.del(key);
    } catch {
      // fail closed — see the docblock. Leaving a marker in place costs at most one
      // token lifetime; clearing one we could not read could undo a ban.
    }
  }
}
