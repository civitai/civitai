// Web-push dispatch, called by the fan-out worker once per fanned PendingNotification row. Sits
// AFTER the DB write committed and after the opt-out filter, so the only questions left are: which
// of the affected users asked for push on this type, which subscriptions do they hold, and is the
// user under their daily cap.
//
// Payload rendering happens in the main app (POST /api/internal/notifications/render-push) — the
// processor registry that turns type+details into title/body/url only exists there.

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
      `${mainAppUrl}/api/internal/notifications/render-push?token=${mainAppWebhookToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: [{ type, details }] }),
      }
    );
    if (!res.ok) {
      logToAxiom({
        type: 'error',
        message: 'push render endpoint failed',
        data: { status: res.status, notificationType: type },
      }).catch(() => {});
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

async function deleteSubscription(id: number) {
  await mainDbWrite().cancellableQuery(`DELETE FROM "PushSubscription" WHERE id = $1`, [id]);
}

async function recordSuccess(id: number) {
  await mainDbWrite().cancellableQuery(
    `UPDATE "PushSubscription" SET "lastSuccessAt" = NOW(), "failureCount" = 0 WHERE id = $1`,
    [id]
  );
}

/** Increments the failure streak; deletes the row once it hits the ceiling. */
async function recordFailure(id: number) {
  await mainDbWrite().cancellableQuery(
    `WITH bumped AS (
       UPDATE "PushSubscription" SET "failureCount" = "failureCount" + 1
       WHERE id = $1
       RETURNING id, "failureCount"
     )
     DELETE FROM "PushSubscription"
     WHERE id IN (SELECT id FROM bumped WHERE "failureCount" >= $2)`,
    [id, MAX_CONSECUTIVE_FAILURES]
  );
}

async function sendToSubscription(sub: SubscriptionRow, payload: PushPayload) {
  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const body = JSON.stringify(payload);
  try {
    await webPush.sendNotification(subscription, body, { TTL: 60 * 60 * 24 });
    pushDeliveryTotal.inc({ outcome: 'accepted' });
    await recordSuccess(sub.id);
  } catch (e: any) {
    const status: number | undefined = e?.statusCode;
    if (status === 404 || status === 410) {
      // The subscription is gone (permission revoked, browser reinstalled). Normal, not an incident.
      pushDeliveryTotal.inc({ outcome: 'expired' });
      await deleteSubscription(sub.id);
    } else if (status === 429) {
      // Rate limited by the push service — drop this send, keep the subscription.
      pushDeliveryTotal.inc({ outcome: 'rate_limited' });
    } else if (status === 413) {
      pushDeliveryTotal.inc({ outcome: 'payload_too_large' });
      logToAxiom({
        type: 'error',
        message: 'push payload too large — payload bug, not a subscription bug',
        data: { bytes: body.length },
      }).catch(() => {});
      try {
        await webPush.sendNotification(
          subscription,
          JSON.stringify({ ...payload, body: payload.body.slice(0, TRUNCATED_BODY_LENGTH) }),
          { TTL: 60 * 60 * 24 }
        );
        await recordSuccess(sub.id);
      } catch {
        await recordFailure(sub.id);
      }
    } else {
      pushDeliveryTotal.inc({ outcome: 'failure' });
      await recordFailure(sub.id);
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
      for (const sub of subs) {
        await sendToSubscription(sub, effective);
      }
    }
  } catch (e) {
    logAxiomError(e as Error);
  }
}
