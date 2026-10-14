import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Server-side rate limits for App Blocks SHARED storage writes — `apps.shared.append`
 * / `.update` (the token-bucket write budget at the end of this file), and fixed
 * windows for `.vote` / `.unvote` (vote bucket), `.report`, and `.withdraw`. That is
 * EVERY write op on the shared surface.
 *
 * WHY (hardened design H4 — "weaponized users"): shared storage opens the app
 * datastore to cross-user PUBLIC writes for the first time. A trusted-but-hostile
 * (or compromised) account could flood requests or brigade votes. These caps are
 * the second leg of the containment triad (trust-gate + rate-limit + mod-approval):
 * they bound the write volume a SINGLE user can push through a SINGLE app,
 * independent of the per-app quota (which bounds bytes, not per-user velocity).
 *
 * KEYING (design H4): keyed on `(user_id, appBlockId)` — NOT the block instance,
 * NOT the token `jti`. The token subject (`user_id`) is the abuse principal, and
 * `appBlockId` scopes the budget per app, so one user hammering app A does not eat
 * their budget for app B, and churning fresh tokens can't reset the window (the
 * subject is stable). Sub-namespaced under the shared blocks rate-limit key so
 * these buckets never contend with the mint (`TOKEN_RATE_LIMIT:<subject>:...`) or
 * catalog (`:catalog:`) buckets.
 *
 * PATTERN (fixed windows): the established blocks fixed-window limiter — INCR + EXPIRE
 * on the `redis` cache client, byte-identical shape to `checkBlockCatalogRateLimit` and
 * `BlockTokenService.checkRateLimit`. FAIL-OPEN on any redis error: a limiter-redis
 * incident must never break legitimate writes (the trust-gate + content-moderation
 * + mod-approval remain as the durable controls). We NEVER fail-closed here because
 * the abuse ceiling is a defence-in-depth layer, not the authorization boundary.
 */

// VOTE: M votes/min/app/user. Covers a user rapidly up-voting a browsed list
// while bounding a scripted brigade. Symmetric bucket covers vote + unvote so a
// toggle-spam loop is also capped.
export const SHARED_VOTE_RATE_LIMIT_MAX = 30;
export const SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS = 60;

// REPORT: R reports/day/app/user. A report is a rare, moderator-facing action
// that files a row AND fires a mod-channel webhook — so unlike votes it is the
// abuse SURFACE (report-table growth + Discord flooding), not just noise. The
// per-(reporter, key) dedup collapses re-reports of the SAME row; this daily
// bucket bounds a flood of DISTINCT-key reports (the residual webhook-spam
// vector) from a single user.
export const SHARED_REPORT_RATE_LIMIT_MAX = 20;
export const SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

// WITHDRAW: W withdrawals/min/app/user. `apps.shared.withdraw` was the ONE write
// op on this surface with NO bucket at all — every sibling (append, update, vote,
// unvote, report) has one. It is a DELETE of the caller's OWN shared_kv row, so it
// grows nothing; what each call does spend is a pooled connection, a real
// transaction, an FK cascade across votes/counters/reports and a quota trigger —
// i.e. the cost profile of `vote`, not of `append`.
//
// So it takes the VOTE shape (30/min) rather than the report daily shape,
// and deliberately its OWN sub-namespace rather than sharing the vote bucket:
//   - the DAILY shape is wrong here. With a per-user shared_kv row cap of 50, a
//     user legitimately clearing their own history can need dozens of withdrawals
//     in one sitting; a 20/day ceiling would strand rows they have every right to
//     delete — a worse failure than the flood it bounds.
//   - SHARING the vote bucket is wrong for the mirror-image reason: browsing and
//     up-voting a feed is the highest-velocity legitimate action on this surface,
//     and it must never be able to starve a user's ability to delete their own
//     content (nor a cleanup sweep starve their voting).
// 30/min bounds a scripted append/withdraw churn loop while sitting far above any
// human rate. Fail-open like every other bucket here — defence in depth, never the
// authorization boundary.
export const SHARED_WITHDRAW_RATE_LIMIT_MAX = 30;
export const SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS = 60;

export type SharedStorageRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

async function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number
): Promise<SharedStorageRateLimitResult> {
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, windowSeconds);
    } else {
      // Re-assert a lost TTL (crash between INCR and EXPIRE would otherwise strand
      // a TTL-less key → permanent lock). Same mitigation as the mint limiter.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, windowSeconds);
    }

    if (count <= max) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = windowSeconds;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — a redis incident must not break shared writes.
    return { allowed: true };
  }
}

/** One `vote`/`unvote` against the (user, app) per-minute bucket. */
export async function checkSharedVoteRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-vote:${appBlockId}:${userId}` as const;
  return checkFixedWindow(key, SHARED_VOTE_RATE_LIMIT_MAX, SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS);
}

/** One `withdraw` against the (user, app) per-minute bucket (own sub-namespace). */
export async function checkSharedWithdrawRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-withdraw:${appBlockId}:${userId}` as const;
  return checkFixedWindow(
    key,
    SHARED_WITHDRAW_RATE_LIMIT_MAX,
    SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS
  );
}

/** One `report` against the (user, app) daily bucket (own sub-namespace). */
export async function checkSharedReportRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-report:${appBlockId}:${userId}` as const;
  return checkFixedWindow(
    key,
    SHARED_REPORT_RATE_LIMIT_MAX,
    SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS
  );
}

// DOCUMENT STORE (`/api/v1/blocks/storage/*`). Same fixed-window counter, own sub-namespaces
// so the new surface never shares a bucket with the legacy one. Keyed on the resolved app id,
// which is per (app, namespace) for review previews. Shared DOCUMENT writes do not have a bucket
// here: they spend the token-bucket write budget below (`reserveSharedWrite`), as the legacy
// append/update do.
//   reads             — per (app, viewer), or per (app, client IP) for an anonymous viewer;
//   writes            — per (app, viewer): private document writes, and every DELETE (a
//                       viewer's own shared documents included — see the route);
//   marks + counters  — per (app, viewer), every mark and counter write;
//   report            — per (app, viewer) per day, on top of the marks + counters bucket.
export const DOC_STORE_READ_RATE_LIMIT_MAX = 300;
export const DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX = 120;
// Marks + counters and reports take the legacy vote and report limits (own buckets, same numbers).
export const DOC_STORE_TALLY_RATE_LIMIT_MAX = SHARED_VOTE_RATE_LIMIT_MAX;
export const DOC_STORE_REPORT_RATE_LIMIT_MAX = SHARED_REPORT_RATE_LIMIT_MAX;
const MINUTE_SECONDS = 60;

export type DocStoreRateBucket = 'read' | 'write' | 'tally' | 'report';

const DOC_STORE_BUCKETS: Record<DocStoreRateBucket, { max: number; windowSeconds: number }> = {
  read: { max: DOC_STORE_READ_RATE_LIMIT_MAX, windowSeconds: MINUTE_SECONDS },
  write: { max: DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX, windowSeconds: MINUTE_SECONDS },
  tally: {
    max: DOC_STORE_TALLY_RATE_LIMIT_MAX,
    windowSeconds: SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS,
  },
  report: {
    max: DOC_STORE_REPORT_RATE_LIMIT_MAX,
    windowSeconds: SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS,
  },
};

/**
 * One request against a document-store bucket. `principal` is `u:<userId>` for a signed-in
 * viewer or `ip:<address>` for an anonymous reader; the caller builds it. Fails open.
 */
export async function checkDocStoreRateLimit(
  bucket: DocStoreRateBucket,
  appId: string,
  principal: string
): Promise<SharedStorageRateLimitResult> {
  const { max, windowSeconds } = DOC_STORE_BUCKETS[bucket];
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-${bucket}:${appId}:${principal}` as const;
  return checkFixedWindow(key, max, windowSeconds);
}

// STORE ITEMS (app sub-listings): every publish/edit by one user for one parent app, in an
// hourly and a daily bucket. Lives here to share the fixed-window counter; it is not a
// shared-storage op.
export const SUB_LISTING_WRITE_HOURLY_MAX = 30;
export const SUB_LISTING_WRITE_DAILY_MAX = 100;

export async function checkSubListingWriteRateLimit(
  userId: number,
  parentListingId: string
): Promise<SharedStorageRateLimitResult> {
  const base = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:sub-listing-write:${parentListingId}:${userId}`;
  const hourly = await checkFixedWindow(`${base}:h`, SUB_LISTING_WRITE_HOURLY_MAX, 60 * 60);
  if (!hourly.allowed) return hourly;
  return checkFixedWindow(`${base}:d`, SUB_LISTING_WRITE_DAILY_MAX, 24 * 60 * 60);
}

// CATALOG SYNC (an off-site parent's platform publishing through `/api/v1/catalog/items`): one
// bucket per parent, since the platform writes for many creators. Identical re-syncs are not
// counted.
export const SUB_LISTING_SYNC_HOURLY_MAX = 600;
export const SUB_LISTING_SYNC_DAILY_MAX = 3000;

export async function checkSubListingSyncRateLimit(
  parentListingId: string
): Promise<SharedStorageRateLimitResult> {
  const base = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:sub-listing-sync:${parentListingId}`;
  const hourly = await checkFixedWindow(`${base}:h`, SUB_LISTING_SYNC_HOURLY_MAX, 60 * 60);
  if (!hourly.allowed) return hourly;
  return checkFixedWindow(`${base}:d`, SUB_LISTING_SYNC_DAILY_MAX, 24 * 60 * 60);
}

// ── WRITE BUDGET (append + update, one shared budget per (user, app)) ─────────
//
// Token buckets: the budget refills continuously, and only writes that LAND spend it — the
// caller reserves a token before moderation and releases it if the write never lands
// (civitai/civitai-app-starters#597). A write that fails for any reason other than a marked
// server fault is also charged to a separate rejection bucket, capping moderation spent on
// writes that never land (the router's `withSharedWriteBudget` decides which failures those are).

export type TokenBucketParams = { capacity: number; refillIntervalMs: number };
export type SharedWriteBudgetParams = {
  burst: TokenBucketParams;
  daily: TokenBucketParams;
  rejections: TokenBucketParams;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const SHARED_WRITE_BUDGET: SharedWriteBudgetParams = {
  // 10 covers a normal session or a verification walk without waiting.
  burst: { capacity: 10, refillIntervalMs: 6 * 60 * 1000 },
  // Matches the 50-row per-user cap (SHARED_KV_PER_USER_ROW_CAP). It refills continuously
  // (one every ~29 min), so exhausting it costs ~29 min, not up to 24h.
  daily: { capacity: 50, refillIntervalMs: DAY_MS / 50 },
  // Writes refused after the reserve (moderation block, row cap, quota, NOT_FOUND, …).
  //
  // DEBT: a rejection is charged when the refused write RETURNS, so concurrent writes that all
  // passed the reserve are all charged, and the bucket can go below empty, to a floor of
  // -capacity (enforced in the script). Writes in flight at once are bounded by the burst
  // capacity (plus any burst refill during a slow write).
  //   - Clamping at empty instead would let every refilled token admit a fresh wave of
  //     burst-capacity refused writes: (DAY_MS / refillIntervalMs) × burst capacity moderation
  //     runs per day.
  //   - With the debt, charges per day are at most
  //     capacity + DAY_MS / refillIntervalMs + (burst capacity - 1).
  // The cost: a caller in debt d waits (d + 1) × refillIntervalMs for the next write. Only a
  // caller with more refused writes in flight than tokens left goes into debt at all, and the
  // floor caps the wait at (capacity + 1) × refillIntervalMs.
  rejections: { capacity: 10, refillIntervalMs: 30 * 60 * 1000 },
};

/**
 * One EVAL against the (user, app) hash, so every bucket moves atomically and the script
 * touches a single key (cluster-slot safe). Each field holds the instant (ms, Redis `TIME`)
 * at which that bucket is FULL again; a bucket holds a token while that instant is at most
 * `(capacity - 1) * interval` ahead of now. Integer arithmetic only, formatted with `%.0f`,
 * so the same script behaves identically under Redis's Lua 5.1 and the tests' Lua 5.4.
 *
 * ARGV: op ('reserve' | 'release'), then capacity + interval for burst, daily, rejections,
 * then for 'release' whether to charge a rejection ('1').
 * Returns { 1, 0 } on success, { 0, waitMs } when a reserve is refused (state untouched).
 */
const SHARED_WRITE_BUDGET_SCRIPT = `
local caps = { tonumber(ARGV[2]), tonumber(ARGV[4]), tonumber(ARGV[6]) }
local ivs = { tonumber(ARGV[3]), tonumber(ARGV[5]), tonumber(ARGV[7]) }
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local stored = redis.call('HMGET', KEYS[1], 'b', 'd', 'r')
local full = {}
for i = 1, 3 do
  full[i] = math.max(tonumber(stored[i]) or now, now)
end

if ARGV[1] == 'reserve' then
  local wait = 0
  for i = 1, 3 do
    local w = full[i] - now - (caps[i] - 1) * ivs[i]
    if w > wait then wait = w end
  end
  if wait > 0 then return { 0, wait } end
  full[1] = full[1] + ivs[1]
  full[2] = full[2] + ivs[2]
else
  full[1] = math.max(full[1] - ivs[1], now)
  full[2] = math.max(full[2] - ivs[2], now)
  if ARGV[8] == '1' then
    -- Debt is kept, bounded at -capacity: a concurrent burst is repaid (not forgiven, see
    -- SHARED_WRITE_BUDGET.rejections for the cost of each choice), never a permanent lock.
    full[3] = math.min(full[3] + ivs[3], now + 2 * caps[3] * ivs[3])
  end
end

local ttl = math.max(full[1], full[2], full[3]) - now
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('HSET', KEYS[1],
    'b', string.format('%.0f', full[1]),
    'd', string.format('%.0f', full[2]),
    'r', string.format('%.0f', full[3]))
  redis.call('PEXPIRE', KEYS[1], string.format('%.0f', ttl))
end
return { 1, 0 }
`;

export type SharedWriteReservation =
  | {
      allowed: true;
      /** Give the write token back; `rejected` also charges the rejection bucket. Never throws. */
      release: (opts: { rejected: boolean }) => Promise<void>;
    }
  | { allowed: false; retryAfterSeconds: number };

function sharedWriteBudgetKey(userId: number, appBlockId: string) {
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-write:v2:${appBlockId}:${userId}`;
}

function budgetArgs(params: SharedWriteBudgetParams) {
  return [params.burst, params.daily, params.rejections].flatMap((b) => [
    String(b.capacity),
    String(b.refillIntervalMs),
  ]);
}

/**
 * Reserve one write token from the (user, app) budget shared by append and update. Refused
 * (consuming nothing) while the burst, daily or rejection bucket is empty; `retryAfterSeconds`
 * is the wait until the binding bucket has a token. Fails open.
 */
export async function reserveSharedWrite(
  userId: number,
  appBlockId: string,
  params: SharedWriteBudgetParams = SHARED_WRITE_BUDGET
): Promise<SharedWriteReservation> {
  const key = sharedWriteBudgetKey(userId, appBlockId);
  const args = budgetArgs(params);
  let reply: unknown;
  try {
    reply = await redis.eval(SHARED_WRITE_BUDGET_SCRIPT, {
      keys: [key],
      arguments: ['reserve', ...args],
    });
  } catch {
    return { allowed: true, release: async () => undefined };
  }
  const [ok, waitMs] = Array.isArray(reply) ? reply.map(Number) : [1, 0];
  if (ok !== 1) {
    const seconds = Math.ceil(waitMs / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Number.isFinite(seconds) ? Math.max(1, seconds) : 1,
    };
  }
  return {
    allowed: true,
    release: async ({ rejected }) => {
      try {
        await redis.eval(SHARED_WRITE_BUDGET_SCRIPT, {
          keys: [key],
          arguments: ['release', ...args, rejected ? '1' : '0'],
        });
      } catch {
        // A lost refund costs the user one token; never fail the request over it.
      }
    },
  };
}
