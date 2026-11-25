import { dbWrite } from '~/server/db/client';

/**
 * `KeyValue` row holding a JSON array of processor keys `send-notifications` skips, e.g.
 * `["new-model-version"]`. Delete the row to resume. A paused type's cursor does not move, so on
 * resume a cursor-only query sends the whole backlog since the pause, while one with a wall-clock
 * floor (new-model-version: 30 minutes) sends only what that floor still reaches.
 */
export const PAUSED_NOTIFICATION_TYPES_KEY = 'paused-notification-types';

/** Throws on a malformed row so the run sends nothing rather than ignoring an intended pause. */
export async function getPausedNotificationTypes() {
  // primary: an operator's pause must hold from the very next run, not after replica lag.
  const row = await dbWrite.keyValue.findUnique({ where: { key: PAUSED_NOTIFICATION_TYPES_KEY } });
  if (!row) return new Set<string>();
  const value = row.value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(`${PAUSED_NOTIFICATION_TYPES_KEY} must be a JSON array of strings`);
  return new Set(value as string[]);
}
