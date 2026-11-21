import { env } from '~/env/server';
import { signHibernationRequest } from '~/server/services/app-hibernation/internal-auth';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { boundedClusterCall } from '~/server/utils/cluster-window-count';
import { outboundFetch } from '~/server/utils/fetch-timeout';

/**
 * App Assistant direct preview: REVOCATION. When civitai ends a direct preview session (stop, idle
 * reap, a failed start) or bans its user, it tells the sandbox service to rotate the Sandbox's
 * preview id, so the preview gateway stops serving the session host at once instead of at its
 * expiry. This is the civitai side of that call.
 *
 * Wire contract, `POST <APP_ASSISTANT_SANDBOX_URL>/internal/v1/previews/revoke`:
 *   body      {userId: <number>, previewId: <32 hex> | "*", issuedAt?: <epoch ms, "*" only>, reason}
 *   headers   x-preview-revoke-timestamp: <unix seconds>
 *             x-preview-revoke-signature: v1=<hex HMAC-SHA256(secret.trim(), canonical)>
 *   canonical "v1\nPOST\n/internal/v1/previews/revoke\n" + timestamp + "\n" + hex sha256(body bytes)
 * the same canonical scheme as the app-hibernation channel (`app-hibernation/internal-auth.ts`),
 * under its own secret, PREVIEW_REVOKE_HMAC_SECRET. A `"*"` revoke rotates every Sandbox of the
 * user whose id was set at or before `issuedAt`, so a late delivery cannot end a session opened
 * after an unban; `issuedAt` is the first send attempt plus a 120 s clock-skew margin, and a retry
 * keeps it.
 *
 * Delivery is at least once and the call is idempotent. Each caller tries once inline; on any
 * retryable answer the revoke is queued UNSIGNED on the cache cluster and the dev-tunnel reaper
 * drains the queue every run, signing each request as it sends it, so the 300 s signature window
 * always fits. A queued revoke older than the 8 h session cap is dropped: every session host it
 * could match has expired by then.
 *
 * Retryable: a network error, or any status except 2xx and the dropped ones (400, 405, 413); 401,
 * 404, 409 and 5xx are the expected retryable ones. A 404 in particular is the gateway with direct
 * preview switched off (its rollback), which answers 404 on this path; the revoke stays queued until
 * it is switched back on. Not retryable (dropped, logged): 400, 405 and 413, which mean this request
 * itself is wrong and will be refused the same way every time. Not configured
 * (APP_ASSISTANT_SANDBOX_URL or the secret unset) also queues, so a revoke is never lost to a
 * configuration gap shorter than the session cap.
 *
 * Never throws: a revoke must never fail a stop, a reap or a ban.
 */

export const PREVIEW_REVOKE_PATH = '/internal/v1/previews/revoke';
export const PREVIEW_REVOKE_HEADERS = {
  timestamp: 'x-preview-revoke-timestamp',
  signature: 'x-preview-revoke-signature',
} as const;
/** Added to a `"*"` revoke's first send attempt: the clock difference between the two clusters, and a session opened while the ban propagates. */
export const PREVIEW_REVOKE_ISSUED_AT_MARGIN_MS = 120_000;
/** A queued revoke older than this is dropped (the 8 h session cap). */
export const PREVIEW_REVOKE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;
/** At most this many queued revokes are sent per reaper run, so a long outage cannot stall it. */
const DRAIN_BATCH = 50;
/**
 * A drain run stops after this many consecutive network or 5xx failures (a timeout is a network
 * failure), so a down sandbox service costs a run at most this many send timeouts.
 */
const DRAIN_MAX_CONSECUTIVE_FAILURES = 3;

export type PreviewRevoke = {
  userId: number;
  /** One session's preview id (32 lowercase hex), or "*" for every Sandbox of the user. */
  previewId: string;
  /** Epoch milliseconds; required for "*", never sent otherwise. */
  issuedAt?: number;
  reason: string;
};

type QueuedRevoke = PreviewRevoke & { queuedAt: number };

export type PreviewRevokeOutcome = 'sent' | 'retry' | 'drop';

const QUEUE_KEY = `${REDIS_KEYS.BLOCKS.DEV_TUNNEL_USER}:preview-revoke-queue` as const;
const fieldOf = (r: Pick<PreviewRevoke, 'userId' | 'previewId'>) => `${r.userId}:${r.previewId}`;
const cluster = <T>(fn: string, op: () => Promise<T>) =>
  boundedClusterCall(`previewRevoke.${fn}`, op);

/** HSET the entry and floor the queue's TTL at the session cap, in one script. */
const ENQUEUE = `
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  if redis.call('TTL', KEYS[1]) < tonumber(ARGV[3]) then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
  return 1
`;
/** HDEL the entry only while it still holds the value this run read (a newer one stays). */
const DEQUEUE_IF_UNCHANGED = `
  if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) end
  return 0
`;

/** The body (exact bytes) and headers of one signed revoke request at `nowMs`. */
export function buildPreviewRevokeRequest(
  revoke: PreviewRevoke,
  secret: string,
  nowMs: number
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    userId: revoke.userId,
    previewId: revoke.previewId,
    ...(revoke.previewId === '*' ? { issuedAt: revoke.issuedAt } : {}),
    reason: revoke.reason.slice(0, 64),
  });
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [PREVIEW_REVOKE_HEADERS.timestamp]: timestamp,
      [PREVIEW_REVOKE_HEADERS.signature]: signHibernationRequest(secret, {
        method: 'POST',
        path: PREVIEW_REVOKE_PATH,
        timestamp,
        body: Buffer.from(body),
      }),
    },
  };
}

/** What an HTTP status from the revoke path means for the revoke. */
export function classifyPreviewRevokeStatus(status: number): PreviewRevokeOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 400 || status === 405 || status === 413) return 'drop';
  return 'retry';
}

/**
 * What one send attempt saw: the HTTP status, `network` (no answer: refused, reset, timed out) or
 * `unconfigured` (APP_ASSISTANT_SANDBOX_URL or the secret unset; nothing was sent).
 */
export type PreviewRevokeAttemptStatus = number | 'network' | 'unconfigured';

type Attempt = { outcome: PreviewRevokeOutcome; status: PreviewRevokeAttemptStatus };

/**
 * One signed send. A refused (dropped) answer and a retried failure are logged with the status
 * they got, never with the request's signature or the secret. Two retried answers stay quiet, as
 * they are expected rather than faults: a 404 (the gateway's rollback answer, which can last as
 * long as the rollback) and `unconfigured` (the feature not set up on this deployment). The
 * reaper's drain summary still reports both as its last status.
 */
async function sendOnce(revoke: PreviewRevoke, nowMs: number): Promise<Attempt> {
  const base = env.APP_ASSISTANT_SANDBOX_URL;
  const secret = env.PREVIEW_REVOKE_HMAC_SECRET;
  if (!base || !secret?.trim()) return { outcome: 'retry', status: 'unconfigured' };
  const { body, headers } = buildPreviewRevokeRequest(revoke, secret, nowMs);
  let attempt: Attempt;
  try {
    const res = await outboundFetch(`${base.replace(/\/+$/, '')}${PREVIEW_REVOKE_PATH}`, {
      method: 'POST',
      headers,
      body,
      timeoutMs: SEND_TIMEOUT_MS,
    });
    attempt = { outcome: classifyPreviewRevokeStatus(res.status), status: res.status };
  } catch {
    attempt = { outcome: 'retry', status: 'network' };
  }
  if (attempt.outcome === 'drop')
    logToAxiom({
      type: 'app-assistant.preview-revoke.refused',
      message: `Preview revoke refused with ${attempt.status}; dropped`,
      userId: revoke.userId,
      status: attempt.status,
      reason: revoke.reason,
    });
  else if (attempt.outcome === 'retry' && attempt.status !== 404)
    logToAxiom({
      type: 'app-assistant.preview-revoke.retry',
      message: `Preview revoke failed with ${attempt.status}; kept for retry`,
      userId: revoke.userId,
      status: attempt.status,
      reason: revoke.reason,
    });
  return attempt;
}

async function enqueue(entry: QueuedRevoke): Promise<void> {
  try {
    await cluster('enqueue', () =>
      redis.eval(ENQUEUE, {
        keys: [QUEUE_KEY],
        arguments: [
          fieldOf(entry),
          JSON.stringify(entry),
          String(Math.ceil(PREVIEW_REVOKE_MAX_AGE_MS / 1000)),
        ],
      })
    );
  } catch {
    // Lost: the session host still expires at its exp (at most the 8 h cap).
    logToAxiom({
      type: 'app-assistant.preview-revoke.queue-failed',
      message: 'A preview revoke could not be queued for retry',
      userId: entry.userId,
      reason: entry.reason,
    });
  }
}

/** Try once now; queue for the reaper on anything retryable. Never throws. */
async function deliver(revoke: PreviewRevoke, nowMs: number): Promise<PreviewRevokeOutcome> {
  const { outcome } = await sendOnce(revoke, nowMs);
  if (outcome === 'retry') await enqueue({ ...revoke, queuedAt: nowMs });
  return outcome;
}

/** Revoke one ended session's preview id. Never throws. */
export async function revokePreviewSession(
  revoke: { userId: number; previewId: string; reason: string },
  nowMs: number = Date.now()
): Promise<PreviewRevokeOutcome> {
  try {
    return await deliver(
      { userId: revoke.userId, previewId: revoke.previewId, reason: revoke.reason },
      nowMs
    );
  } catch {
    return 'retry';
  }
}

/** Revoke every preview session of a banned user (`"*"`, issuedAt = now + margin). Never throws. */
export async function revokePreviewsForBannedUser(
  userId: number,
  nowMs: number = Date.now()
): Promise<PreviewRevokeOutcome> {
  try {
    return await deliver(
      {
        userId,
        previewId: '*',
        issuedAt: nowMs + PREVIEW_REVOKE_ISSUED_AT_MARGIN_MS,
        reason: 'ban',
      },
      nowMs
    );
  } catch {
    return 'retry';
  }
}

/** On unban: drop a `"*"` revoke still queued for the user. Never throws. */
export async function clearQueuedBanRevoke(userId: number): Promise<void> {
  try {
    await cluster('clearBan', () => redis.hDel(QUEUE_KEY, fieldOf({ userId, previewId: '*' })));
  } catch {}
}

function parseQueued(raw: unknown): QueuedRevoke | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as Partial<QueuedRevoke>;
    if (!Number.isSafeInteger(v.userId) || typeof v.previewId !== 'string') return null;
    if (typeof v.reason !== 'string' || !Number.isFinite(v.queuedAt)) return null;
    if (v.previewId === '*' && !Number.isSafeInteger(v.issuedAt)) return null;
    return v as QueuedRevoke;
  } catch {
    return null;
  }
}

export type PreviewRevokeDrain = {
  sent: number;
  dropped: number;
  retrying: number;
  /** The status of the last send this run attempted; absent when it attempted none. */
  lastStatus?: PreviewRevokeAttemptStatus;
  /** Set only when the run stopped early: the entries of this run's batch it left untried. */
  unattempted?: number;
};

const isOutageStatus = (s: PreviewRevokeAttemptStatus) =>
  s === 'network' || (typeof s === 'number' && s >= 500);

/**
 * Send every queued revoke (at most DRAIN_BATCH a run), each signed now and with its original
 * `issuedAt`. Sent and refused ones leave the queue; retryable ones stay; one older than the 8 h
 * cap, or unreadable, is dropped (an aged one is logged, so a revoke that never got through is
 * visible rather than silently lost). After DRAIN_MAX_CONSECUTIVE_FAILURES consecutive network or
 * 5xx failures the run stops and leaves the rest queued for the next one. Run by the dev-tunnel
 * reaper, which logs the counts. Never throws.
 */
export async function drainPreviewRevokeQueue(
  nowMs: number = Date.now()
): Promise<PreviewRevokeDrain> {
  const out: PreviewRevokeDrain = { sent: 0, dropped: 0, retrying: 0 };
  let entries: Record<string, string>;
  try {
    entries = (await cluster('drain.read', () => redis.hGetAll(QUEUE_KEY))) ?? {};
  } catch {
    return out;
  }
  const batch = Object.entries(entries).slice(0, DRAIN_BATCH);
  let consecutiveFailures = 0;
  for (const [i, [field, raw]] of batch.entries()) {
    if (consecutiveFailures >= DRAIN_MAX_CONSECUTIVE_FAILURES) {
      out.unattempted = batch.length - i;
      logToAxiom({
        type: 'app-assistant.preview-revoke.drain-stopped',
        message: `Preview revoke drain stopped after ${consecutiveFailures} consecutive failures`,
        payload: { ...out },
      });
      break;
    }
    const entry = parseQueued(raw);
    let outcome: PreviewRevokeOutcome;
    if (!entry) outcome = 'drop';
    else if (nowMs - entry.queuedAt > PREVIEW_REVOKE_MAX_AGE_MS) {
      outcome = 'drop';
      logToAxiom({
        type: 'app-assistant.preview-revoke.expired',
        message: 'A queued preview revoke outlived its retry window; dropped unsent',
        userId: entry.userId,
        reason: entry.reason,
        payload: { ageMs: nowMs - entry.queuedAt },
      });
    } else {
      const attempt = await sendOnce(entry, nowMs);
      outcome = attempt.outcome;
      out.lastStatus = attempt.status;
      consecutiveFailures = isOutageStatus(attempt.status) ? consecutiveFailures + 1 : 0;
    }
    if (outcome === 'retry') {
      out.retrying += 1;
      continue;
    }
    if (outcome === 'sent') out.sent += 1;
    else out.dropped += 1;
    try {
      await cluster('drain.remove', () =>
        redis.eval(DEQUEUE_IF_UNCHANGED, { keys: [QUEUE_KEY], arguments: [field, String(raw)] })
      );
    } catch {
      // Left queued: sent again next run, which is harmless (idempotent).
    }
  }
  return out;
}
