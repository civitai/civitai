import { SignalMessages } from '~/server/common/enums';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { hSetMultiWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { createLogger } from '~/utils/logging';
import { signalClient } from '~/utils/signal-client';
import { clearSessionCache } from './session-cache';
import { sessionClient } from './session-client';
import {
  observeSessionStateChunk,
  observeSessionStateUpdate,
  type SessionStateCaller,
} from './session-metrics';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
// Fields per HSCAN page. Only bounds how many field names come back per round trip; the scan is incremental
// either way, so this trades round trips against per-command size rather than affecting correctness.
const SCAN_PAGE = 500;
// 🔴 Aggregate bound for the scan. `withSysReadDeadline` bounds ONE page, and a bounded primitive repeated an
// unbounded number of times is not bounded: the largest account is 108 pages at this COUNT, so a sysRedis
// degraded enough that every page returns just under its own deadline would hang a logout or ban request for
// minutes while the per-page fail-open never trips. This caps the whole scan instead. Exceeding it yields a
// PARTIAL token list, which is reported distinctly rather than as a normal read — see below.
const SCAN_BUDGET_MS = 3000;
const log = createLogger('session-invalidation', 'green');

type RefreshSessionOptions = { sendSignal?: boolean; caller?: SessionStateCaller };

async function updateSessionState(
  userId: number,
  type: 'refresh' | 'invalid',
  caller: SessionStateCaller
) {
  const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;
  const startedAt = Date.now();

  // Only the FIELD NAMES are used below, so scan for names and never fetch values. `hGetAll` pulled every
  // value across the wire and discarded it, and it is one O(N) command: measured on the shared store at
  // 39-43ms for the largest account, from several pods at once, blocking its single command thread each time.
  // HSCAN is incremental, so no single command scales with the hash — which also means this read can no
  // longer exceed the deadline below purely by being large, and therefore can no longer fail open to an
  // empty set and silently skip the invalidation.
  let userTokens: string[] = [];
  let truncated = false;
  try {
    // Wall-clock deadline + fail-open: this read is on the user-facing
    // logout / ban / session-refresh path. A fast sysRedis DOWN would 500
    // the request; a silent half-open would park the awaited command ~11min.
    // On DOWN/SLOW we fail open to an empty token list — symmetric with the
    // already-fail-open write below and the documented invalidateSession
    // posture: the invalidation doesn't take effect during the outage (retry
    // after recovery), but the request never 500s or parks. Each page is
    // raced separately, so the bound applies per page rather than to the
    // whole scan.
    // HSCAN may return the same field twice across pages when the hash rehashes mid-scan. The write dedupes
    // structurally, but the COUNT feeding the log line and the histogram would over-report without this.
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const page = await withSysReadDeadline(
        sysRedis.hScanNoValues(key as any, cursor, { COUNT: SCAN_PAGE })
      );
      for (const field of page.fields) seen.add(field);
      cursor = String(page.cursor);
      if (cursor !== '0' && Date.now() - startedAt > SCAN_BUDGET_MS) {
        truncated = true;
        break;
      }
    } while (cursor !== '0');
    userTokens = [...seen];
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'session-invalidation.updateSessionState read', err, {
      userId,
      type,
    });
    userTokens = [];
  }
  if (truncated) {
    // Distinct from both a clean read and a failed one: we have SOME tokens and will mark them, but this
    // user is not fully revoked and the caller must be able to tell. Marking the ones we did read is still
    // strictly better than marking none.
    logSysRedisFailOpen(
      'read-degraded',
      'session-invalidation.updateSessionState read (truncated)',
      new Error(`scan exceeded ${SCAN_BUDGET_MS}ms budget`),
      { userId, type, tokensRead: userTokens.length }
    );
  }
  // Must stay O(n): spreading the accumulator per iteration is O(n^2), which
  // blocks the event loop for minutes on the largest token hashes.
  const userTokensObj: Record<string, string> = Object.fromEntries(
    userTokens.map((token) => [token, type] as const)
  );

  let chunksWritten = 0;
  let chunksTotal = 0;
  // This is where the hub's shaped session-user entry (`session:data2:{userId}`, 4h TTL) gets busted —
  // `clearSessionCache` asks the hub to drop it, so the next read re-produces from the DB. It runs on
  // BOTH the 'refresh' and 'invalid' paths, and unconditionally (not gated on the token scan above), so
  // every per-user caller of refreshSession/invalidateSession gets a fresh shape on the next read.
  await clearSessionCache(userId);
  if (userTokens.length > 0) {
    // Atomic multi-field set+TTL — single EVAL replaces the sequential
    // hSet (multi-field) + hExpire (multi-field). The previous pair could
    // leave a subset of fields no-TTL if the second call failed; here all
    // fields land with the same DEFAULT_EXPIRATION TTL atomically.
    //
    // Fail-open wrapper: an in-flight EVAL throw during a sysRedis
    // sentinel failover (Phase 4) would otherwise propagate up into the
    // next-auth `update` callback chain (refreshSession → here) and 500
    // the user-facing request. Match the pattern from PR #2286 / the
    // setToken helper in token-refresh.ts. The throw class we tolerate
    // here is sysRedis unreachability; the trade-off is documented on
    // invalidateSession below (read path in token-refresh.ts is already
    // fail-open, so the unobserved write is symmetric).
    try {
      await hSetMultiWithTTL(
        sysRedis,
        REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
        userTokensObj,
        DEFAULT_EXPIRATION * 1000,
        ({ durationSeconds, chunkIndex, chunkTotal }) => {
          observeSessionStateChunk(caller, type, durationSeconds);
          chunksWritten = chunkIndex + 1;
          chunksTotal = chunkTotal;
        }
      );
    } catch (err) {
      // chunksWritten vs chunksTotal is the difference between "revoked none of them" and "revoked 29 of
      // 54" — without it a partial write and a total failure produce identical log lines, and a moderator
      // reads success either way.
      logSysRedisFailOpen('write-degraded', 'session-invalidation.updateSessionState', err, {
        userId,
        type,
        tokenCount: userTokens.length,
        chunksWritten,
        chunksTotal,
      });
    }
  }
  observeSessionStateUpdate(caller, type, userTokens.length, (Date.now() - startedAt) / 1000);
  return userTokens;
}

async function sendSessionSignal(userId: number, type: 'refresh' | 'invalid') {
  try {
    await signalClient.send({
      userId,
      target: SignalMessages.SessionRefresh,
      data: { type },
    });
  } catch (error) {
    // Don't let signal failures break session invalidation
    log(`Failed to send session ${type} signal to user ${userId}: ${error}`);
  }
}

/**
 * Mark a user's tokens for refresh, bust their cached session state, and signal active sessions.
 *
 * 🔴 This DOES bust the hub's shaped session-user entry (`session:data2:{userId}`) — via
 * `updateSessionState` → `clearSessionCache` → `sessionClient.invalidate`, which POSTs the hub's
 * `/api/auth/identity` and lands in the hub's own `invalidateSessionUser`. So a caller that edits a
 * field carried on the SessionUser shape (username, image/profilePicture, onboarding, settings, …)
 * only has to call this; the next session read re-produces from the DB rather than serving the
 * cached shape for the remainder of its 4h TTL.
 *
 * The main app reaches the hub's `invalidateSessionUser` over HTTP, not by import — grepping for that
 * function name in `src/` finds nothing and reads as "no main-app path busts the cache", which is how
 * this got misdiagnosed in #4298. The seam is pinned by
 * `src/server/controllers/__tests__/user.controller.session-avatar-bust.test.ts`.
 *
 * Contrast `invalidateAllSessions` below, which deliberately does NOT wipe the shape — that exemption
 * is specific to the MASS path and does not apply here.
 */
export async function refreshSession(
  userId: number,
  { sendSignal = true, caller = 'unspecified' }: RefreshSessionOptions = {}
) {
  const userTokens = await updateSessionState(userId, 'refresh', caller);
  if (sendSignal) {
    await sendSessionSignal(userId, 'refresh');
  }

  log(`Refreshed session for user ${userId} - ${userTokens.length} token(s) marked for refresh`);
}

/**
 * Mark a user's tokens as invalid in sysRedis and signal active sessions
 * to log out.
 *
 * SECURITY/IR NOTE: this path is fail-open on sysRedis unreachability
 * on BOTH the read and the write (PR #2332 round-3 audit fix for the
 * write; STEP-4 soft-dependency sweep for the read). Each scan page of the
 * read is wrapped in `withSysReadDeadline` + try/catch and fails open to an
 * empty token list — subtype `read-degraded`; the write (hSetMultiWithTTL)
 * swallows its error — subtype `write-degraded`. Both emit a
 * `sysredis-fail-open` Loki/Axiom event; see `updateSessionState` above.
 * During a sysRedis outage the invalidation does NOT take effect; callers
 * that need guaranteed invalidation (stolen-token reports, account-takeover
 * response) MUST retry after sysRedis recovery. This is symmetric with the
 * downstream read path too:
 * the refreshToken pipeline in token-refresh.ts is already fail-open on
 * read errors, so `tokenState === 'invalid'` is never observed during
 * the outage window even if a prior successful call wrote it — the
 * read itself fails open and the session continues. Throwing here would
 * not have prevented the session from staying alive; it would only have
 * 500'd the user-facing request that triggered the invalidation.
 */
export async function invalidateSession(
  userId: number,
  caller: SessionStateCaller = 'unspecified'
) {
  const userTokens = await updateSessionState(userId, 'invalid', caller);
  await sendSessionSignal(userId, 'invalid');

  log(`Invalidated session for user ${userId} and ${userTokens.length} token(s)`);
}

export async function invalidateAllSessions() {
  // Mass invalidation is hub-owned: set the global revocation cutoff (the shared SESSION.ALL marker the hub
  // registry owns) through the hub rather than writing it directly — revokes every token signed before now.
  // 🔴 THIS MASS PATH ONLY: the shared session:data2 cache is NOT wiped, because a cluster-wide SCAN+del
  // costs far more than the freshness it buys and its 4h TTL bounds the staleness. The PER-USER paths above
  // (refreshSession / invalidateSession) DO wipe it — do not read this sentence as a statement about them.
  await sessionClient.invalidateAll();
  log(`Scheduling session refresh for all users`);
}
