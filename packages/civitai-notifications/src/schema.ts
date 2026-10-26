import * as z from 'zod';
import { notificationCategories } from './constants';

// The notification producer contract — the single source of truth the notifications app validates
// POST bodies against and that every caller types against. Moved here (from the monolith's
// notification.schema.ts / notification.service.ts) so producer and consumer can never disagree on
// the wire shape.

const notificationCategory = z.enum(notificationCategories);

/**
 * Identifies the underlying *event* a notification was derived from, shared by every type that can fire
 * for it (a comment that is simultaneously an @mention, a thread reply, and a comment on your model
 * carries one `dedupeKey` across all three). A partial UNIQUE ("userId", "dedupeKey") on
 * `UserNotification` collapses those to the first one that lands; `key` stays per-type so the queue and
 * `Notification` rows are unaffected. Null opts a type out of cross-type dedup entirely.
 */
const dedupeKey = z.string().nullish();

export const notificationSingleRow = z.object({
  key: z.string(),
  userId: z.number(),
  type: z.string(),
  details: z.record(z.string(), z.any()),
  dedupeKey,
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
export const createNotificationPendingRow = notificationSingleRowFull
  .omit({ userId: true })
  .extend({
    userId: z.number().optional(),
    userIds: z.array(z.number()).optional(),
    debounceSeconds: z.number().optional(),
  })
  // The debounce fan-out path writes UserNotification with a TARGETED ON CONFLICT that cannot absorb a
  // violation of the dedupe index, so it never writes "dedupeKey" — a row asking for both would have its
  // dedupeKey silently dropped. Reject it here instead of failing quietly at fan-out.
  .refine((row) => !(row.dedupeKey && row.debounceSeconds !== undefined), {
    message: 'dedupeKey is not supported on debounced notifications',
    path: ['dedupeKey'],
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
  // The count is a lower bound: the recount stopped at its row limit before reaching every matching row.
  floor: z.boolean().optional(),
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
  dedupeKey,
});
export type CreateNotificationRow = z.infer<typeof createNotificationRow>;
export const createNotificationsBulkInput = z.array(createNotificationRow);
export type CreateNotificationsBulkInput = z.infer<typeof createNotificationsBulkInput>;

export const cleanupNotificationsInput = z.object({
  /** Delete UserNotification rows created before this instant. */
  before: z.coerce.date(),
});
export type CleanupNotificationsInput = z.infer<typeof cleanupNotificationsInput>;

// --- System notices (POST /notifications/notices) --------------------------------------------------

export const systemNoticeTypes = ['system-message', 'system-announcement'] as const;
export type SystemNoticeType = (typeof systemNoticeTypes)[number];
export const MAX_NOTICE_RECIPIENTS = 50_000;
export const MAX_NOTICE_PARAM_LENGTH = 100;
export const MAX_NOTICE_MESSAGE_LENGTH = 500;

const placeholderPattern = /\{([A-Za-z0-9_]+)\}/g;

export function noticePlaceholders(message: string): string[] {
  return [...new Set([...message.matchAll(placeholderPattern)].map((m) => m[1]))];
}

export function renderNoticeMessage(message: string, params: Record<string, string> = {}): string {
  return message.replace(placeholderPattern, (_, name: string) => params[name] ?? `{${name}}`);
}

const noticeUserId = z.number().int().positive();
const hasHtml = (s: string) => /[<>]/.test(s);

export const sendSystemNoticesInput = z
  .object({
    sendId: z.string().regex(/^[a-z0-9-]{3,80}$/, 'sendId must match [a-z0-9-]{3,80}'),
    mode: z.enum(['dry-run', 'send']).default('dry-run'),
    type: z.enum(systemNoticeTypes),
    message: z
      .string()
      .min(1)
      .max(MAX_NOTICE_MESSAGE_LENGTH)
      .refine((s) => !hasHtml(s), 'message may not contain HTML'),
    // A leading "//" is protocol-relative, i.e. off-site.
    url: z
      .string()
      .max(1000)
      .regex(/^\/(?!\/)/, 'url must be a site path starting with "/"')
      .optional(),
    userIds: z.array(noticeUserId).optional(),
    recipients: z
      .array(
        z.object({
          userId: noticeUserId,
          params: z.record(z.string(), z.string().max(MAX_NOTICE_PARAM_LENGTH)),
        })
      )
      .optional(),
    includeInactive: z.boolean().default(false),
    sentBy: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(200),
  })
  .superRefine((input, ctx) => {
    if (!!input.userIds === !!input.recipients) {
      ctx.addIssue({ code: 'custom', message: 'Pass exactly one of userIds or recipients' });
      return;
    }
    const ids = input.userIds ?? input.recipients!.map((r) => r.userId);
    if (ids.length < 1 || ids.length > MAX_NOTICE_RECIPIENTS) {
      ctx.addIssue({
        code: 'custom',
        message: `Between 1 and ${MAX_NOTICE_RECIPIENTS} recipients per call (got ${ids.length})`,
      });
      return;
    }
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const id of ids) (seen.has(id) ? duplicates : seen).add(id);
    if (duplicates.size) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate userIds: ${[...duplicates].slice(0, 100).join(', ')}`,
      });
    }

    const placeholders = noticePlaceholders(input.message);
    if (input.userIds) {
      if (placeholders.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['message'],
          message: `message has placeholders (${placeholders.join(
            ', '
          )}); use recipients with params`,
        });
      }
      return;
    }
    const expected = new Set(placeholders);
    const bad: number[] = [];
    for (const { userId, params } of input.recipients!) {
      const keys = Object.keys(params);
      const rendered = renderNoticeMessage(input.message, params);
      if (
        keys.length !== expected.size ||
        keys.some((k) => !expected.has(k)) ||
        rendered.length > MAX_NOTICE_MESSAGE_LENGTH ||
        Object.values(params).some(hasHtml)
      ) {
        bad.push(userId);
      }
    }
    if (bad.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['recipients'],
        message: `params must supply exactly {${placeholders.join(
          ', '
        )}}, with no HTML and a rendered message of at most ${MAX_NOTICE_MESSAGE_LENGTH} characters; failing userIds: ${bad
          .slice(0, 100)
          .join(', ')}${bad.length > 100 ? ` (+${bad.length - 100} more)` : ''}`,
      });
    }
  });
export type SendSystemNoticesInput = z.input<typeof sendSystemNoticesInput>;
export type SendSystemNoticesParsed = z.output<typeof sendSystemNoticesInput>;

export const noticeBuckets = [
  'queued',
  'optedOut',
  'unknownUser',
  'inactiveUser',
  'alreadySent',
] as const;
export type NoticeBucket = (typeof noticeBuckets)[number];

export type SendSystemNoticesResult = {
  sendId: string;
  mode: 'dry-run' | 'send';
  requested: number;
  counts: Record<NoticeBucket, number>;
  samples: Array<{ userId: number; message: string; url?: string }>;
  /** Dropped userIds per bucket, capped at 1,000 each. */
  dropped: Partial<Record<Exclude<NoticeBucket, 'queued'>, number[]>>;
};

export const getSystemNoticeSendInput = z.object({ sendId: z.string() });
export type GetSystemNoticeSendInput = z.infer<typeof getSystemNoticeSendInput>;

export type SystemNoticeSendRecord = {
  sendId: string;
  type: SystemNoticeType;
  message: string;
  url: string | null;
  contentHash: string;
  sentBy: string;
  actorUserId: number | null;
  reason: string;
  credential: string;
  requested: number;
  queued: number;
  optedOut: number;
  unknownUser: number;
  inactiveUser: number;
  alreadySent: number;
  dryRuns: number;
  sends: number;
  firstAt: string;
  lastAt: string;
};
