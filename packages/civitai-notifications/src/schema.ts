import * as z from 'zod';
import { notificationCategories } from './constants';

// The notification producer contract — the single source of truth the notifications app validates
// POST bodies against and that every caller types against. Moved here (from the monolith's
// notification.schema.ts / notification.service.ts) so producer and consumer can never disagree on
// the wire shape.

const notificationCategory = z.enum(notificationCategories);

export const notificationSingleRow = z.object({
  key: z.string(),
  userId: z.number(),
  type: z.string(),
  details: z.record(z.string(), z.any()),
});
export type NotificationSingleRow = z.infer<typeof notificationSingleRow>;

export const notificationSingleRowFull = notificationSingleRow.extend({
  category: notificationCategory,
});
export type NotificationSingleRowFull = z.infer<typeof notificationSingleRowFull>;

/**
 * The producer payload. `userId` / `userIds` are merged into a single recipient set server-side;
 * `debounceSeconds` opts the row into the debounce path (a settle window before fan-out). This is the
 * exact shape the monolith's `createNotification` accepted, lifted into the shared seam.
 */
export const createNotificationPendingRow = notificationSingleRowFull.omit({ userId: true }).extend({
  userId: z.number().optional(),
  userIds: z.array(z.number()).optional(),
  debounceSeconds: z.number().optional(),
});
export type CreateNotificationPendingRow = z.infer<typeof createNotificationPendingRow>;

// --- Read / count / mark / exists / bulk / cleanup contracts (the app's authed API) ------------------
// `userId` is supplied by the TRUSTED caller: the monolith authenticates the user via tRPC, then calls
// the app (over the internal, shared-secret ingress) with the resolved id. The app does not re-auth the
// end user — it trusts the caller, exactly like any internal service-to-service read.

/** One notification as returned by the read API — the base row BEFORE the monolith enriches `details`. */
export const notificationRow = z.object({
  id: z.number(),
  type: z.string(),
  category: notificationCategory,
  details: z.record(z.string(), z.any()),
  createdAt: z.coerce.date(),
  read: z.boolean(),
});
export type NotificationRow = z.infer<typeof notificationRow>;

export const notificationCategoryCount = z.object({
  category: notificationCategory,
  count: z.coerce.number(),
});
export type NotificationCategoryCount = z.infer<typeof notificationCategoryCount>;

export const queryNotificationsInput = z.object({
  userId: z.number(),
  limit: z.number().optional(),
  cursor: z.coerce.date().optional(),
  category: notificationCategory.nullish(),
  unread: z.boolean().optional(),
});
export type QueryNotificationsInput = z.infer<typeof queryNotificationsInput>;

export const countNotificationsInput = z.object({
  userId: z.number(),
  unread: z.boolean().default(false),
  category: notificationCategory.nullish(),
});
export type CountNotificationsInput = z.infer<typeof countNotificationsInput>;

export const markReadInput = z.object({
  userId: z.number(),
  id: z.coerce.number().optional(),
  all: z.boolean().optional(),
  category: notificationCategory.nullish(),
});
export type MarkReadInput = z.infer<typeof markReadInput>;

export const notificationExistsInput = z.object({ key: z.string() });
export type NotificationExistsInput = z.infer<typeof notificationExistsInput>;

/** A pre-resolved pending row (recipients already computed, no settings filter) — the bulk producer path
 * used by the notification-generator job. Distinct from `createNotificationPendingRow`, which resolves
 * userId(s) + applies the opt-out filter. */
export const createNotificationRow = z.object({
  key: z.string(),
  type: z.string(),
  category: notificationCategory,
  users: z.array(z.number()),
  details: z.record(z.string(), z.any()),
  debounceSeconds: z.number().optional(),
});
export type CreateNotificationRow = z.infer<typeof createNotificationRow>;
export const createNotificationsBulkInput = z.array(createNotificationRow);
export type CreateNotificationsBulkInput = z.infer<typeof createNotificationsBulkInput>;

export const cleanupNotificationsInput = z.object({
  /** Delete UserNotification rows created before this instant. */
  before: z.coerce.date(),
});
export type CleanupNotificationsInput = z.infer<typeof cleanupNotificationsInput>;
