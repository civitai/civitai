// Producer "create" path — the settings-filter + PendingNotification upsert. This is the monolith's
// createNotification (src/server/services/notification.service.ts) moved into the process that OWNS the
// notif-DB pools, now able to read the main DB's userNotificationSettings directly (§2b/§2c) instead of
// the monolith reaching across the repo boundary. The queue row it writes is what the fan-out worker
// then picks up — the producer↔consumer contract is the PendingNotification table, unchanged.

import type { CreateNotificationPendingRow } from '@civitai/notifications';
import { mainDbRead, notifDbWrite } from './clients/db';
import { logToAxiom } from './clients/axiom';

export type CreateNotificationResult = {
  /** Recipients that remained after the opt-out filter (0 = nothing queued). */
  queued: number;
};

/**
 * Resolve the recipient set, drop users who opted out of this notification `type`, and UPSERT the
 * PendingNotification queue row. Best-effort by contract: a failure is logged and swallowed (the
 * monolith did the same) so a producer's request never fails on a notification hiccup.
 */
export async function createNotification(
  data: CreateNotificationPendingRow
): Promise<CreateNotificationResult> {
  const userIds = [...(data.userIds ?? [])];
  if (data.userId) userIds.push(data.userId);
  const recipients = [...new Set(userIds)];
  if (recipients.length === 0) return { queued: 0 };

  try {
    // Opt-out filter: a row in UserNotificationSettings for (userId, type) means the user disabled it.
    // The -1 sentinel is never a real user and is always dropped (matches the monolith).
    const settingsResp = await mainDbRead().cancellableQuery<{ userId: number }>(
      `SELECT "userId" FROM "UserNotificationSettings" WHERE "userId" = ANY($1::int[]) AND "type" = $2`,
      [recipients, data.type]
    );
    const disabled = new Set((await settingsResp.result()).map((r) => r.userId));
    const targets = recipients.filter((id) => id !== -1 && !disabled.has(id));
    if (targets.length === 0) return { queued: 0 };

    // UPDATE-first to avoid burning a sequence id when the key already exists; the INSERT ... ON
    // CONFLICT (key) DO UPDATE fallback handles the cross-writer race where another writer inserts the
    // same key between our UPDATE and INSERT.
    const updateResp = await notifDbWrite().cancellableQuery<{ id: number }>(
      `UPDATE "PendingNotification"
         SET "users" = ARRAY(SELECT DISTINCT unnest("users" || $1::int[])), "lastTriggered" = NOW()
       WHERE "key" = $2
       RETURNING id`,
      [targets, data.key]
    );
    const updated = await updateResp.result();

    if (updated.length === 0) {
      const insertResp = await notifDbWrite().cancellableQuery(
        `INSERT INTO "PendingNotification" (key, type, category, users, details, "debounceSeconds")
         VALUES ($1, $2, $3::"NotificationCategory", $4::int[], $5::jsonb, $6)
         ON CONFLICT (key)
         DO UPDATE SET "users" = ARRAY(SELECT DISTINCT unnest("PendingNotification"."users" || excluded."users")), "lastTriggered" = NOW()`,
        [
          data.key,
          data.type,
          data.category,
          targets,
          JSON.stringify(data.details),
          data.debounceSeconds ?? null,
        ]
      );
      await insertResp.result();
    }

    return { queued: targets.length };
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'warning',
      name: 'Failed to create notification',
      details: { key: data.key },
      message: error.message,
      stack: error.stack,
    }).catch(() => {});
    return { queued: 0 };
  }
}
