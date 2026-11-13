import * as z from 'zod';

// Inside what Postgres stores, so an out-of-range date is a 400, not a database error.
export const CURSOR_MIN_DATE = new Date('2000-01-01T00:00:00.000Z');
export const CURSOR_MAX_DATE = new Date('9999-12-31T23:59:59.999Z');
const MAX_ROW_ID = '9223372036854775807';

/** A date off the wire (JSON carries it as a string). */
export const cursorDate = z.coerce.date().min(CURSOR_MIN_DATE).max(CURSOR_MAX_DATE);

// "createdAt" is timestamp(6): a JS Date would drop the microseconds and skip rows at a page boundary,
// so the position stays text end to end, as `cursorAt` (see the list query) writes it.
const CURSOR_AT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}$/;
// "UserNotification".id is bigint and past 2^31; past 2^53 a JS number would round it.
const ROW_ID_PATTERN = /^[1-9]\d{0,18}$/;

function isCursorAt(value: string) {
  const match = CURSOR_AT_PATTERN.exec(value);
  if (!match) return false;
  const iso = `${match[1]}Z`;
  const date = new Date(iso);
  // The ISO round-trip rejects dates the pattern admits but the calendar does not (02-30).
  if (Number.isNaN(date.getTime()) || date.toISOString() !== iso) return false;
  return date >= CURSOR_MIN_DATE && date <= CURSOR_MAX_DATE;
}

function isRowId(value: string) {
  // Same-length digit strings without a leading zero compare as their numbers do.
  return ROW_ID_PATTERN.test(value) && (value.length < MAX_ROW_ID.length || value <= MAX_ROW_ID);
}

/** Keyset position in a user's notification list, newest first: the last row a page showed. */
export const notificationListCursor = z.object({
  /** UTC `YYYY-MM-DDTHH:MM:SS.ffffff`, no zone. */
  createdAt: z.string().refine(isCursorAt),
  id: z.string().refine(isRowId),
});
export type NotificationListCursor = z.infer<typeof notificationListCursor>;

export function encodeNotificationCursor({ createdAt, id }: NotificationListCursor): string {
  return `${createdAt}|${id}`;
}

/**
 * Reads the opaque cursor string a client sends back; anything `encodeNotificationCursor` could not
 * have written is `undefined`. A plain function, not a schema: the main app validates with its own zod.
 */
export function parseNotificationCursor(value: string): NotificationListCursor | undefined {
  if (value.length > 60) return undefined;
  const [createdAt, id, ...rest] = value.split('|');
  if (rest.length || createdAt === undefined || id === undefined) return undefined;
  if (!isCursorAt(createdAt) || !isRowId(id)) return undefined;
  return { createdAt, id };
}

/**
 * Splits the `limit + 1` rows a list query fetched into the page and the cursor for the next one.
 * The cursor is the last row SHOWN, so the next page starts strictly after it.
 */
export function pageNotifications<T extends { id: number | string; cursorAt: string }>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last
      ? encodeNotificationCursor({ createdAt: last.cursorAt, id: String(last.id) })
      : undefined,
  };
}
