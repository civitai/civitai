import {
  createNotificationPendingRow,
  createNotificationsBulkInput,
  type CleanupNotificationsInput,
  type CountNotificationsInput,
  type CreateNotificationPendingRow,
  type CreateNotificationRow,
  type MarkReadInput,
  type NotificationCategoryCount,
  type NotificationExistsInput,
  type NotificationRow,
  type QueryNotificationsInput,
} from './schema';

// The client seam. Producers/readers depend ONLY on these functions + the shared schema; whether they
// hit the notifications app over HTTP (this impl) or something else is a swap behind the package that
// never touches a caller. Every call authenticates with the shared-secret bearer token on the app's
// internal-only ingress.

export type NotificationsClientConfig = {
  /** Base URL of the notifications app, e.g. `http://notifications.civitai-app.svc`. */
  endpoint?: string;
  /** Shared secret for the internal-only ingress (WEBHOOK_TOKEN-style). */
  token?: string;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Per-call timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
};

export class NotificationsClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'NotificationsClientError';
  }
}

function resolveConfig(config: NotificationsClientConfig) {
  const endpoint = config.endpoint ?? process.env.NOTIFICATIONS_ENDPOINT;
  if (!endpoint) {
    throw new NotificationsClientError(
      'No notifications endpoint configured (pass `endpoint` or set NOTIFICATIONS_ENDPOINT).'
    );
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new NotificationsClientError('No fetch implementation available (pass `fetch`).');
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    token: config.token ?? process.env.NOTIFICATIONS_TOKEN ?? '',
    fetch: fetchImpl,
    timeoutMs: config.timeoutMs ?? 10_000,
  };
}

/** POST a JSON body to the app and return the parsed JSON response (or undefined for empty bodies). */
async function post(path: string, body: unknown, config: NotificationsClientConfig): Promise<unknown> {
  const { endpoint, token, fetch: fetchImpl, timeoutMs } = resolveConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${endpoint}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotificationsClientError(
        `notifications ${path} failed (${res.status})${text ? `: ${text}` : ''}`,
        res.status
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch (err) {
    if (err instanceof NotificationsClientError) throw err;
    throw new NotificationsClientError((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a notification (settings-filtered). Validates against the shared schema before it leaves the
 * producer, then POSTs to the app. On a hot path treat creation as best-effort: this throws
 * `NotificationsClientError` on a non-2xx/transport failure, so wrap-and-log rather than letting it break
 * the request.
 */
export async function createNotification(
  data: CreateNotificationPendingRow,
  config: NotificationsClientConfig = {}
): Promise<void> {
  await post('/notifications', createNotificationPendingRow.parse(data), config);
}

/** Rows per bulk POST. Bounds each HTTP payload so a large producer run (the notification-generator job
 * can emit tens of thousands of rows, each with a potentially large `users[]`) can't exceed the app's
 * body limit — the DB-write batching within the app is separate. */
const BULK_HTTP_BATCH_SIZE = 1000;

/** Bulk producer path: pre-resolved rows (recipients already computed, NO opt-out filter). Chunked into
 * bounded POSTs; sequential so a big run doesn't fan out an unbounded number of concurrent requests. */
export async function createNotificationsBulk(
  rows: CreateNotificationRow[],
  config: NotificationsClientConfig = {}
): Promise<void> {
  const validated = createNotificationsBulkInput.parse(rows);
  for (let i = 0; i < validated.length; i += BULK_HTTP_BATCH_SIZE) {
    await post('/notifications/bulk', validated.slice(i, i + BULK_HTTP_BATCH_SIZE), config);
  }
}

/** Base notification rows for a user (unenriched — the caller enriches `details` from the main DB). The
 * app's response is trusted (internal, shared-secret), so we don't re-validate it — just cast to the
 * static type and hydrate `createdAt`, which JSON carries as an ISO string but callers need as a Date
 * (the tRPC cursor is `z.date()`). */
export async function queryNotifications(
  input: QueryNotificationsInput,
  config: NotificationsClientConfig = {}
): Promise<NotificationRow[]> {
  const res = (await post('/notifications/query', input, config)) as Array<
    Omit<NotificationRow, 'createdAt'> & { createdAt: string }
  >;
  return res.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
}

/** Per-category unread (or total) counts for a user. pg returns COUNT(*) as a string; coerce to number. */
export async function countNotifications(
  input: CountNotificationsInput,
  config: NotificationsClientConfig = {}
): Promise<NotificationCategoryCount[]> {
  const res = (await post('/notifications/count', input, config)) as Array<
    Omit<NotificationCategoryCount, 'count'> & { count: number | string }
  >;
  return res.map((c) => ({ category: c.category, count: Number(c.count) }));
}

/** Mark one / all / a category of a user's notifications read. Fire-and-forget by contract. */
export async function markNotificationsRead(
  input: MarkReadInput,
  config: NotificationsClientConfig = {}
): Promise<void> {
  await post('/notifications/mark-read', input, config);
}

/** Whether a Notification with this `key` already exists (producer-side dedup). */
export async function notificationExists(
  input: NotificationExistsInput,
  config: NotificationsClientConfig = {}
): Promise<boolean> {
  const res = (await post('/notifications/exists', input, config)) as { exists?: boolean } | undefined;
  return res?.exists === true;
}

/** Delete UserNotification rows older than `before`. Returns the deleted count. */
export async function cleanupNotifications(
  input: CleanupNotificationsInput,
  config: NotificationsClientConfig = {}
): Promise<{ deleted: number }> {
  const res = (await post('/notifications/cleanup', input, config)) as { deleted?: number } | undefined;
  return { deleted: res?.deleted ?? 0 };
}
