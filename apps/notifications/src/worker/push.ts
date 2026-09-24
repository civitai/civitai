// Web-push dispatch, called by the fan-out worker once per fanned PendingNotification row. Sits
// AFTER the DB write committed and after the opt-out filter, so the only questions left are: which
// of the affected users asked for push on this type, which subscriptions do they hold, and is the
// user under their daily cap.
//
// Payload rendering happens in the main app (POST /api/internal/notifications/render-push) — the
// processor registry that turns type+details into title/body/url only exists there.

import { chunk } from 'lodash-es';
import webPush from 'web-push';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { logAxiomError, logToAxiom } from '../lib/server/clients/axiom';
import { mainDbRead, mainDbWrite } from '../lib/server/clients/db';
import { getRedis } from '../lib/server/clients/redis';
import {
  mainAppUrl,
  mainAppWebhookToken,
  pushDailyCap,
  pushEnabled,
  vapidPrivateKey,
  vapidPublicKey,
  vapidSubject,
} from '../env';
import { pushDeliveryTotal } from '../lib/server/metrics';

const MAX_CONSECUTIVE_FAILURES = 10;
/** Body ceiling for the 413 retry — push services reject payloads past ~4KB. */
const TRUNCATED_BODY_LENGTH = 500;
/**
 * The poll loop awaits dispatch before signals and the next pending row, so sends are bounded in
 * both directions: at most this many in flight (a high-fanout notification can't open thousands of
 * sockets), and each send hard-capped by `timeout` (web-push otherwise has none — one hung push
 * service socket would stall ALL fan-out).
 */
const SEND_CONCURRENCY = 10;
const SEND_OPTIONS = { TTL: 60 * 60 * 24, timeout: 10_000 };
/**
 * The render call is the one outbound request in the awaited path that `SEND_OPTIONS.timeout`
 * does NOT cover — node's fetch has no default timeout, so a main-app instance that accepts the
 * connection and never answers would stall `run()` before signals and before the next pending
 * row, i.e. all fan-out, not just push. Same ceiling as a send.
 */
const RENDER_TIMEOUT_MS = 10_000;

/** Bookkeeping is best-effort: a transient main-DB write failure on one device must not abort the
 *  remaining sends for the notification. */
function bestEffort(promise: Promise<unknown>) {
  return promise.catch((e) => logAxiomError(e as Error));
}

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return;
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  vapidConfigured = true;
}

type SubscriptionRow = {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushPayload = { title: string; body: string; url: string | null };

function quotaKey(userId: number) {
  const day = new Date().toISOString().slice(0, 10);
  return `${REDIS_KEYS.SYSTEM.PUSH_QUOTA}:${userId}:${day}` as RedisKeyTemplateCache;
}

/**
 * Returns 'send' while under the cap, 'summary' exactly once when the cap is crossed, then 'skip'
 * for the rest of the day. No redis → 'send': the cap is a courtesy throttle, not a billing gate,
 * and silently dropping every push because redis is down would be the worse failure.
 */
async function checkQuota(userId: number): Promise<'send' | 'summary' | 'skip'> {
  const redis = getRedis();
  if (!redis) return 'send';
  try {
    const key = quotaKey(userId);
    const count = await redis.incrBy(key, 1);
    // 48h: slack past the UTC day boundary; the key is only ever addressed by current UTC date.
    if (count === 1) await redis.expire(key, 60 * 60 * 48);
    if (count <= pushDailyCap) return 'send';
    if (count === pushDailyCap + 1) return 'summary';
    return 'skip';
  } catch (e) {
    logAxiomError(e as Error);
    return 'send';
  }
}

async function renderPayload(
  type: string,
  details: Record<string, any>
): Promise<PushPayload | null> {
  try {
    const res = await fetch(
      // encodeURIComponent, not raw: a token containing `&`, `#`, `+` or `%` would otherwise be
      // truncated or mangled into a value the endpoint rejects, and the only symptom is push
      // silently never rendering (renderPayload returns null on !ok).
      `${mainAppUrl}/api/internal/notifications/render-push?token=${encodeURIComponent(
        mainAppWebhookToken
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: [{ type, details }] }),
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      logToAxiom({
        type: 'error',
        message: 'push render endpoint failed',
        data: { status: res.status, notificationType: type },
      }).catch(() => null);
      return null;
    }
    const data = (await res.json()) as { results: (PushPayload | null)[] };
    return data.results[0] ?? null;
  } catch (e) {
    logAxiomError(e as Error);
    return null;
  }
}

/** Affected users who hold a UserPushSetting row for this type, with their live subscriptions. */
async function getTargetSubscriptions(userIds: number[], type: string): Promise<SubscriptionRow[]> {
  const query = await mainDbRead().cancellableQuery<SubscriptionRow>(
    `SELECT ps.id, ps."userId", ps.endpoint, ps.p256dh, ps.auth
     FROM "PushSubscription" ps
     JOIN "UserPushSetting" ups ON ups."userId" = ps."userId" AND ups."type" = $2
     WHERE ps."userId" = ANY($1::int[])`,
    [userIds, type]
  );
  return await query.result();
}

// Every bookkeeping write below re-asserts `"userId" = <the owner we targeted>` alongside the row
// id. A `PushSubscription` row is keyed on the browser's endpoint, and `upsertPushSubscription`
// REASSIGNS that row to a new `userId` when the same browser subscribes under a different account
// (same device, new login). The dispatcher read its target list before sending, so between the read
// and these writes the row can already belong to someone else — an unqualified `WHERE id = $1`
// would then stamp `lastSuccessAt`, bump a failure streak, or DELETE the new owner's live
// subscription on the strength of a send made for the previous owner. Scoping by userId makes the
// write a no-op in exactly that case, which is the correct outcome: the row is no longer ours.

async function deleteSubscription(id: number, userId: number) {
  await mainDbWrite().cancellableQuery(
    `DELETE FROM "PushSubscription" WHERE id = $1 AND "userId" = $2`,
    [id, userId]
  );
}

async function recordSuccess(id: number, userId: number) {
  await mainDbWrite().cancellableQuery(
    `UPDATE "PushSubscription" SET "lastSuccessAt" = NOW(), "failureCount" = 0
     WHERE id = $1 AND "userId" = $2`,
    [id, userId]
  );
}

/** Increments the failure streak; deletes the row once it hits the ceiling. */
async function recordFailure(id: number, userId: number) {
  await mainDbWrite().cancellableQuery(
    `WITH bumped AS (
       UPDATE "PushSubscription" SET "failureCount" = "failureCount" + 1
       WHERE id = $1 AND "userId" = $3
       RETURNING id, "failureCount"
     )
     DELETE FROM "PushSubscription"
     WHERE id IN (SELECT id FROM bumped WHERE "failureCount" >= $2)`,
    [id, MAX_CONSECUTIVE_FAILURES, userId]
  );
}

async function sendToSubscription(sub: SubscriptionRow, payload: PushPayload) {
  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const body = JSON.stringify(payload);
  try {
    await webPush.sendNotification(subscription, body, SEND_OPTIONS);
    pushDeliveryTotal.inc({ outcome: 'accepted' });
    await bestEffort(recordSuccess(sub.id, sub.userId));
  } catch (e: any) {
    const status: number | undefined = e?.statusCode;
    if (status === 404 || status === 410) {
      // The subscription is gone (permission revoked, browser reinstalled). Normal, not an incident.
      pushDeliveryTotal.inc({ outcome: 'expired' });
      await bestEffort(deleteSubscription(sub.id, sub.userId));
    } else if (status === 429) {
      // Rate limited by the push service — drop this send, keep the subscription.
      pushDeliveryTotal.inc({ outcome: 'rate_limited' });
    } else if (status === 413) {
      pushDeliveryTotal.inc({ outcome: 'payload_too_large' });
      logToAxiom({
        type: 'error',
        message: 'push payload too large — payload bug, not a subscription bug',
        data: { bytes: body.length },
      }).catch(() => null);
      try {
        await webPush.sendNotification(
          subscription,
          JSON.stringify({ ...payload, body: payload.body.slice(0, TRUNCATED_BODY_LENGTH) }),
          SEND_OPTIONS
        );
        pushDeliveryTotal.inc({ outcome: 'accepted' });
        await bestEffort(recordSuccess(sub.id, sub.userId));
      } catch {
        await bestEffort(recordFailure(sub.id, sub.userId));
      }
    } else {
      pushDeliveryTotal.inc({ outcome: 'failure' });
      await bestEffort(recordFailure(sub.id, sub.userId));
    }
  }
}

/**
 * Dispatch push for one fanned-out notification. Never throws — push is strictly best-effort and
 * must not break fan-out or signals.
 */
export async function dispatchPush(
  type: string,
  details: Record<string, any>,
  affectedUserIds: number[]
) {
  if (!pushEnabled || affectedUserIds.length === 0) return;
  try {
    ensureVapid();
    const subscriptions = await getTargetSubscriptions(affectedUserIds, type);
    if (subscriptions.length === 0) return;

    const payload = await renderPayload(type, details);
    if (!payload) return;

    const byUser = new Map<number, SubscriptionRow[]>();
    for (const sub of subscriptions) {
      const list = byUser.get(sub.userId) ?? [];
      list.push(sub);
      byUser.set(sub.userId, list);
    }

    const jobs: { sub: SubscriptionRow; payload: PushPayload }[] = [];
    for (const [userId, subs] of byUser) {
      const quota = await checkQuota(userId);
      if (quota === 'skip') {
        pushDeliveryTotal.inc({ outcome: 'capped' });
        continue;
      }
      const effective: PushPayload =
        quota === 'summary'
          ? {
              title: 'Civitai',
              body: "You have more notifications waiting — we'll stop pushing for today.",
              url: '/user/notifications',
            }
          : payload;
      for (const sub of subs) jobs.push({ sub, payload: effective });
    }
    for (const batch of chunk(jobs, SEND_CONCURRENCY)) {
      await Promise.all(batch.map((job) => sendToSubscription(job.sub, job.payload)));
    }
  } catch (e) {
    logAxiomError(e as Error);
  }
}
