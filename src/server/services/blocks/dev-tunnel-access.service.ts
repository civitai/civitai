import { TRPCError } from '@trpc/server';
import { resolveUserAppLimit } from '~/server/services/blocks/user-app-caps.service';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  appRateLimitBody,
  appRateLimitMeta,
  rateLimitedTrpcError,
} from '~/server/utils/app-rate-limit';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';
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
/** A rate-limited refusal always carries its `rateLimit` meta. */
export type DevTunnelRefusal =
  | { code: 'FORBIDDEN' | 'NOT_FOUND'; error: string }
  | { code: 'TOO_MANY_REQUESTS'; error: string; rateLimit: RateLimitMeta };

/** The HTTP status of each refusal code, for the routes that answer a refusal over HTTP. */
export const DEV_TUNNEL_REFUSAL_STATUS: Record<DevTunnelRefusalCode, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
};

export const DEV_TUNNELS_UNAVAILABLE = 'Dev tunnels are not available';

/** A refusal as the HTTP routes answer it: its status, body and, when limited, `Retry-After`. */
export function devTunnelRefusalAnswer(refusal: DevTunnelRefusal): {
  status: number;
  json: Record<string, unknown>;
  retryAfterSeconds?: number;
} {
  const status = DEV_TUNNEL_REFUSAL_STATUS[refusal.code];
  if (refusal.code !== 'TOO_MANY_REQUESTS') {
    return { status, json: { error: refusal.error, code: refusal.code } };
  }
  return {
    status,
    // `code` stays the refusal code these routes always sent.
    json: { ...appRateLimitBody(refusal.rateLimit, refusal.error), code: refusal.code },
    retryAfterSeconds: refusal.rateLimit.retryAfterSeconds,
  };
}

/** A refusal as the tRPC error `blocks.startDevTunnel` answers with. */
export function devTunnelRefusalError(refusal: DevTunnelRefusal): TRPCError {
  if (refusal.code === 'TOO_MANY_REQUESTS') {
    return rateLimitedTrpcError(refusal.rateLimit, refusal.error);
  }
  return new TRPCError({ code: refusal.code, message: refusal.error });
}

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
// The window; the limit is the registry's `apps.dev-tunnel-starts`, resolved per user (code
// default 20).
export const EPHEMERAL_DEV_TUNNEL_RATE_LIMIT = { windowSeconds: 3600 } as const;

/**
 * Atomically counts one ephemeral dev-tunnel start against this user's fixed
 * window and returns whether the call is ALLOWED. Same `INCR` + first-hit `EX`
 * (with a ttl<0 self-heal) shape as reserveBlockBuzzSpend / the dev-token
 * limiter. Fails CLOSED (returns false) on a Redis error — an ephemeral tunnel
 * start is not latency-critical, and failing closed here can never block the
 * approved/owned path (which does not call this).
 */
async function checkEphemeralDevTunnelRateLimit(
  userId: number
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const key = `${REDIS_SYS_KEYS.BLOCKS.DEV_TUNNEL_EPHEMERAL_RATE_LIMIT}:${userId}` as const;
  const { windowSeconds } = EPHEMERAL_DEV_TUNNEL_RATE_LIMIT;
  const max = await resolveUserAppLimit('apps.dev-tunnel-starts', userId);
  try {
    const count = await sysRedis.incrBy(key, 1);
    if (count === 1) {
      await sysRedis.expire(key, windowSeconds);
    } else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, windowSeconds);
    }
    if (count <= max) return { allowed: true };
    const ttl = await sysRedis.ttl(key).catch(() => windowSeconds);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  } catch {
    // Fail closed — never silently bypass the ephemeral enumeration limiter. The store is down,
    // not the window spent, so the retry asked for is a short one.
    return { allowed: false, retryAfterSeconds: 60 };
  }
}

function tooManyStarts(retryAfterSeconds: number): DevTunnelRefusal {
  return {
    code: 'TOO_MANY_REQUESTS',
    error: 'Too many dev tunnel starts for unsubmitted apps; please retry shortly',
    rateLimit: appRateLimitMeta('apps.dev-tunnel-starts', retryAfterSeconds),
  };
}

/**
 * Counts one start against the hourly limit when the app is unsubmitted (`ephemeral`, as
 * `authorizeDevTunnelStart` reported it), refusing past the limit; an owned app never counts.
 * For a caller that judged the gates with `countStart: false` and counts only once it knows the
 * call really is a start (App Assistant's direct preview: reusing a session is not one).
 */
export async function claimDevTunnelStart(
  userId: number,
  ephemeral: boolean
): Promise<DevTunnelRefusal | null> {
  if (!ephemeral) return null;
  const rate = await checkEphemeralDevTunnelRateLimit(userId);
  return rate.allowed ? null : tooManyStarts(rate.retryAfterSeconds);
}

/**
 * The dev-tunnel flag, ownership of `blockId`, and (for an unsubmitted app) the hourly start
 * limit, in that order. On success, `blockId` is the RESOLVED, canonical block id: key the tunnel
 * off it, never the raw input. `countStart: false` judges the flag and ownership only; the caller
 * then counts with `claimDevTunnelStart(user.id, ephemeral)` when it does start.
 */
export async function authorizeDevTunnelStart(
  user: SessionUser,
  blockId: string,
  { countStart = true }: { countStart?: boolean } = {}
): Promise<
  { ok: true; blockId: string; ephemeral: boolean } | { ok: false; refusal: DevTunnelRefusal }
> {
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
  const ephemeral = app.status === 'ephemeral';
  if (countStart && ephemeral) {
    const rate = await checkEphemeralDevTunnelRateLimit(user.id);
    if (!rate.allowed) return { ok: false, refusal: tooManyStarts(rate.retryAfterSeconds) };
  }
  return { ok: true, blockId: app.blockId, ephemeral };
}
