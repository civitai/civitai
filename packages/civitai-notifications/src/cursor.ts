import * as z from 'zod';

// Inside what Postgres stores, so an out-of-range date is a 400, not a database error.
export const CURSOR_MIN_DATE = new Date('2000-01-01T00:00:00.000Z');
export const CURSOR_MAX_DATE = new Date('9999-12-31T23:59:59.999Z');
const MAX_ROW_ID = 2_147_483_647;

/** A date off the wire (JSON carries it as a string). */
export const cursorDate = z.coerce.date().min(CURSOR_MIN_DATE).max(CURSOR_MAX_DATE);

/** Keyset position in a user's notification list, newest first: the last row a page showed. */
export const notificationListCursor = z.object({
  createdAt: cursorDate,
  id: z.number().int().min(1).max(MAX_ROW_ID),
});
export type NotificationListCursor = z.infer<typeof notificationListCursor>;

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{1,10})$/;

export function encodeNotificationCursor({ createdAt, id }: NotificationListCursor): string {
  return `${createdAt.toISOString()}|${id}`;
}

/**
 * Reads the opaque cursor string a client sends back; anything `encodeNotificationCursor` could not
 * have written is `undefined`. A plain function, not a schema: the main app validates with its own zod.
 */
export function parseNotificationCursor(value: string): NotificationListCursor | undefined {
  if (value.length > 40) return undefined;
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return undefined;
  const createdAt = new Date(match[1]);
  const id = Number(match[2]);
  // The ISO round-trip rejects dates the pattern admits but the calendar does not (02-30).
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== match[1]) return undefined;
  if (createdAt < CURSOR_MIN_DATE || createdAt > CURSOR_MAX_DATE) return undefined;
  if (id < 1 || id > MAX_ROW_ID) return undefined;
  return { createdAt, id };
}

/**
 * Splits the `limit + 1` rows a list query fetched into the page and the cursor for the next one.
 * The cursor is the last row SHOWN, so the next page starts strictly after it.
 */
export function pageNotifications<T extends { id: number; createdAt: Date }>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: last ? encodeNotificationCursor(last) : undefined };
}
