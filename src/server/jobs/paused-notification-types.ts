import { dbWrite } from '~/server/db/client';

/**
 * `KeyValue` row holding a JSON array of processor keys `send-notifications` skips, e.g.
 * `["new-model-version"]`. Delete the row to resume. A resumed type sends only what its query's
 * own lookback still reaches.
 */
export const PAUSED_NOTIFICATION_TYPES_KEY = 'paused-notification-types';

/** Throws on a malformed row so the run sends nothing rather than ignoring an intended pause. */
export async function getPausedNotificationTypes() {
  const row = await dbWrite.keyValue.findUnique({ where: { key: PAUSED_NOTIFICATION_TYPES_KEY } });
  if (!row) return new Set<string>();
  const value = row.value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(`${PAUSED_NOTIFICATION_TYPES_KEY} must be a JSON array of strings`);
  return new Set(value as string[]);
}
