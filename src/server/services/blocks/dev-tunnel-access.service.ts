import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { isAppBlocksDevTunnelEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
import type { SessionUser } from '~/types/session';

/**
 * WHO MAY OPEN AN APP DEV TUNNEL, AND FOR WHICH APP — the gates `blocks.startDevTunnel` applies
 * after its middleware, in the one place both of its callers read them:
 *   - `blocks.startDevTunnel` (tRPC): a signed-in author — the CLI, or the App Assistant page.
 *   - `/api/internal/app-assistant/dev-tunnel/start`: App Assistant's server runner, for the user
 *     its run grant names.
 *
 * The author capability (`appBlocksAuthor`) and the App Blocks flag are NOT here: the tRPC path
 * checks them in `appDeveloperProcedure` + `enforceAppBlocksFlag`, and the runner path checks them
 * in `getRunnerDevTunnelUser` (App Assistant's own gate already requires `appBlocks`).
 *
 * Refusals carry the tRPC code the procedure throws, so both callers answer a refusal alike.
 */

export type DevTunnelRefusalCode = 'FORBIDDEN' | 'NOT_FOUND' | 'TOO_MANY_REQUESTS';
export type DevTunnelRefusal = { code: DevTunnelRefusalCode; error: string };

export const DEV_TUNNELS_UNAVAILABLE = 'Dev tunnels are not available';

/** The `app-blocks-dev-tunnel` kill switch, for this user. Fail-closed (see the flag's docblock). */
export async function getDevTunnelFlagRefusal(user: SessionUser): Promise<DevTunnelRefusal | null> {
  if (await isAppBlocksDevTunnelEnabled({ user })) return null;
  return { code: 'FORBIDDEN', error: DEV_TUNNELS_UNAVAILABLE };
}

// EPHEMERAL DEV-TUNNEL rate limit (Phase 1 pre-submit). Per-user fixed window,
// bounding how many EPHEMERAL (no-owned-AppBlock) dev-tunnel starts a single
// author can trigger — blunts host-pool enumeration / DoS across many unclaimed
// slugs. Applies ONLY to the ephemeral branch; the approved/owned path never
// increments this counter. ONE counter per user, whichever caller starts the tunnel.
export const EPHEMERAL_DEV_TUNNEL_RATE_LIMIT = { max: 20, windowSeconds: 3600 } as const;

/**
 * Atomically counts one ephemeral dev-tunnel start against this user's fixed
 * window and returns whether the call is ALLOWED. Same `INCR` + first-hit `EX`
 * (with a ttl<0 self-heal) shape as reserveBlockBuzzSpend / the dev-token
 * limiter. Fails CLOSED (returns false) on a Redis error — an ephemeral tunnel
 * start is not latency-critical, and failing closed here can never block the
 * approved/owned path (which does not call this).
 */
async function checkEphemeralDevTunnelRateLimit(userId: number): Promise<boolean> {
  const key = `${REDIS_SYS_KEYS.BLOCKS.DEV_TUNNEL_EPHEMERAL_RATE_LIMIT}:${userId}` as const;
  try {
    const count = await sysRedis.incrBy(key, 1);
    if (count === 1) {
      await sysRedis.expire(key, EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.windowSeconds);
    } else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.windowSeconds);
    }
    return count <= EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.max;
  } catch {
    // Fail closed — never silently bypass the ephemeral enumeration limiter.
    return false;
  }
}

/**
 * The dev-tunnel flag, ownership of `blockId`, and (for an unsubmitted app) the hourly start
 * limit, in that order. On success, `blockId` is the RESOLVED, canonical block id: key the tunnel
 * off it, never the raw input.
 */
export async function authorizeDevTunnelStart(
  user: SessionUser,
  blockId: string
): Promise<{ ok: true; blockId: string } | { ok: false; refusal: DevTunnelRefusal }> {
  const flagRefusal = await getDevTunnelFlagRefusal(user);
  if (flagRefusal) return { ok: false, refusal: flagRefusal };
  // Ownership gate — resolve the caller's OWN app at any status. null → the
  // bare NOT_FOUND (no existence/ownership oracle, mirrors dev-token).
  const app = await BlockRegistry.resolveDevPageBlockForAuthor(blockId, user.id, { db: 'write' });
  if (!app) return { ok: false, refusal: { code: 'NOT_FOUND', error: 'App not found' } };
  // EPHEMERAL PRE-SUBMIT PATH (Phase 1): the caller owns no AppBlock row for
  // this slug yet (resolveEphemeralDevPageBlock returned a synthetic
  // `status:'ephemeral'` resolution — already anti-shadow-guarded so the slug
  // is unclaimed / the caller's own pending / canonical). Rate-limit these
  // host-pool allocations per-user to blunt enumeration / DoS across unclaimed
  // slugs. The approved/owned path skips this entirely.
  //
  // HONEST SECURITY NOTE (not a full "no existence oracle"): a claimed slug
  // returns the bare NOT_FOUND above (consuming NO rate-limit budget) while an
  // unclaimed slug reaches this branch (consuming budget / allocating a host),
  // so a claimed-vs-unclaimed signal is INHERENT — and once a caller exhausts
  // their 20/hr budget, claimed→NOT_FOUND vs unclaimed→429 becomes freely
  // distinguishable. What the guard DOES guarantee: it never distinguishes
  // AMONG the claimed cases (foreign-approved / foreign-pending / foreign-
  // suspended all return the identical bare NOT_FOUND). Approved slugs are
  // already public (they render at `<slug>.civit.ai`), so the only residual
  // leak is the existence of a PENDING/SUSPENDED slug — and only to another
  // author-flagged (trusted-cohort) caller. The 429 message is kept (not
  // suppressed to NOT_FOUND): actionable rate-limit feedback is better UX for
  // that trusted cohort, and it exposes nothing an exhausted-budget probe
  // couldn't already infer.
  if (app.status === 'ephemeral' && !(await checkEphemeralDevTunnelRateLimit(user.id))) {
    return {
      ok: false,
      refusal: {
        code: 'TOO_MANY_REQUESTS',
        error: 'Too many dev tunnel starts for unsubmitted apps; please retry shortly',
      },
    };
  }
  return { ok: true, blockId: app.blockId };
}
