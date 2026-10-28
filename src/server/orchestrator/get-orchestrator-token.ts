import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { observeTokenIdentityMismatch } from '~/server/orchestrator/orchestrator-identity-metrics';
import { getOrMintCachedToken } from '~/server/orchestrator/orchestrator-token-cache';
import {
  decodeOwnedToken,
  encodeOwnedToken,
} from '~/server/orchestrator/orchestrator-token-identity';
import { REDIS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { logToAxiom } from '~/server/logging/client';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

/** Unused since the cookie store was retired. Kept (optional) so existing call sites don't churn;
 *  server-side callers with no request in hand (e.g. the publish → workflow stamp) omit it. */
type Context = {
  req: NextApiRequest;
  res: NextApiResponse;
};

type GetOrchestratorTokenOptions = {
  /**
   * Skip the per-pod LRU + in-flight coalescing layer in front of the
   * DB cold-mint. Use this on CROSS-USER call paths — e.g. the
   * `moderatorProcedure.queryUserGeneratedImages` handler at
   * `routers/orchestrator.router.ts:543-555`, which mints a token for
   * an arbitrary target user. Without this bypass, a compromised
   * moderator account would leave per-target-user cache entries on
   * every pod they touched, lingering up to
   * `ORCHESTRATOR_TOKEN_CACHE_TTL_MS` past account shutdown. Self-call
   * paths (the user is minting for themselves) should leave this
   * unset — they benefit from the amplification dampener.
   *
   * Even with `bypassCache=true`, the sysRedis hash writeback below
   * still runs so other pods can hit the cross-pod cache on the next
   * self-call. Only the per-pod cache is skipped.
   */
  bypassCache?: boolean;
};

export async function getOrchestratorToken(
  userId: number,
  ctx?: Context,
  options: GetOrchestratorTokenOptions = {}
) {
  const redisKey = userId.toString();
  // Fail open on sysRedis: fall through to the getTemporaryUserApiKey
  // fallback path below by setting token=null on error.
  let token: string | null;
  let sysRedisFailed = false;
  try {
    // Wall-clock deadline so a silent sysRedis half-open can't park this read
    // ~11min on every authenticated generation call. A fast DOWN already
    // rejects into the catch below; the SLOW half-open needs the race.
    const raw = decodeRedisString(
      await withSysReadDeadline(
        sysRedis.hGet<string | Buffer>(REDIS_KEYS.GENERATION.TOKENS_OWNED, redisKey)
      )
    );
    // The hash is keyed by userId, so a value bound to anyone else reached this field
    // by a route that does not exist in this code — see orchestrator-token-identity.ts.
    // Refuse it rather than hand a stranger's identity to the orchestrator; `token=null`
    // takes the same fresh-mint path as an ordinary miss.
    const owned = decodeOwnedToken(raw, userId);
    if (owned.outcome === 'mismatch') {
      observeTokenIdentityMismatch('redis');
      logToAxiom({
        name: 'orchestrator-token-identity-mismatch',
        type: 'error',
        layer: 'redis',
        userId,
        ownerId: owned.ownerId,
      }).catch(() => undefined);
    }
    token = owned.token;
  } catch (err) {
    logSysRedisFailOpen('token-mint-amplification', 'getOrchestratorToken hGet', err, {
      userId,
      action: 'minting-fresh-token',
    });
    token = null;
    sysRedisFailed = true;
  }

  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    // Per-pod LRU + in-flight coalescing in front of the DB cold-mint, which caps DB load while
    // sysRedis is down. See orchestrator-token-cache.ts for the full rationale.
    //
    // A healthy miss means the cross-pod entry expired or was dropped (a ban drops it), so a
    // per-pod entry is stale by definition: serve one only when sysRedis could not answer.
    let minted = false;
    const mint = async () => {
      const fresh = await getTemporaryUserApiKey({
        name: generationServiceCookie.name,
        // make the db token live just slightly longer than the cached one
        maxAge: generationServiceCookie.maxAge + 5,
        type: 'System',
        userId,
      });
      minted = true;
      return fresh;
    };
    // Cross-user mints (moderator path) must NOT populate the per-pod
    // cache — Round-5 audit H2. See GetOrchestratorTokenOptions.bypassCache.
    token = options.bypassCache
      ? await mint()
      : await getOrMintCachedToken(userId, mint, { readCache: sysRedisFailed });
    // Only a token minted here is written back. A per-pod hit may hold a revoked key, and a caller
    // that joined another request's in-flight mint leaves the write to that request.
    if (!minted) return token;
    // Cache populate is best-effort: if sysRedis is down we still return
    // the freshly-minted token. Without this catch, the writeback would
    // 500 every call during a sysRedis outage — defeating the read-side
    // fail-open above.
    //
    // Phase 1.5 (PR #2331 follow-up): atomic single-EVAL set+TTL via
    // hSetWithTTL helper. Replaces the prior Promise.all([hSet, hExpire])
    // pair, which had the failure modes catalogued below — most
    // critically the "no-TTL key on a healthy server" case where HEXPIRE
    // arrives before HSET, finds the field missing, and returns 0
    // silently; HSET then writes without TTL.
    //
    // Blast radius if no-TTL landed (pre-fix): NOT a transparent
    // re-mint. The underlying API key from getTemporaryUserApiKey has a
    // DB-side expiresAt (generationServiceCookie.maxAge + 5 ≈ 1h).
    // After that expired, the API key was dead orchestrator-side, but
    // the cached no-TTL token stayed in this hash. Subsequent calls hit
    // the hGet read path above → returned the dead token → orchestrator
    // 401 → user-visible auth failure with no automatic recovery.
    await hSetWithTTL(
      sysRedis,
      REDIS_KEYS.GENERATION.TOKENS_OWNED,
      redisKey,
      encodeOwnedToken(userId, token),
      generationServiceCookie.maxAge * 1000
    ).catch((err) => {
      logSysRedisFailOpen('write-degraded', 'getOrchestratorToken cache writeback', err, {
        userId,
      });
    });
  }
  return token;
}
