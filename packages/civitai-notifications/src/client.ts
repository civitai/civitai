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

export type NotificationsClientConfig = {
  /** Base URL of the notifications app, e.g. `http://notifications.civitai-app.svc`. Falls back to
   * `process.env.NOTIFICATIONS_ENDPOINT`. */
  endpoint?: string;
  /** Shared secret for the internal-only ingress (WEBHOOK_TOKEN-style). Falls back to
   * `process.env.NOTIFICATIONS_TOKEN`. */
  token?: string;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Per-ATTEMPT timeout in ms. Defaults to 10s. Note: with retries the worst-case total is
   * `(retries + 1) * timeoutMs` plus backoffs — connection-refused fails fast, a true hang does not. */
  timeoutMs?: number;
  /** Max RETRIES on transient failures (transport/timeout/5xx/429). Default 2 → up to 3 attempts. 0
   * disables retry. Only transient failures retry; a 4xx (bad payload / auth) throws immediately. All
   * operations are idempotent (upsert-by-key / mark / reads), so retrying is safe. */
  retries?: number;
  /** Base backoff in ms; grows exponentially (`base * 2^attempt`) with jitter, capped at 2s. Default 200. */
  retryBaseMs?: number;
  /** Called once per FINAL request failure (after retries), from the single `post()` choke point — so
   * every failed create/bulk/read/count/mark/exists/cleanup surfaces one event. Wire this to your logger
   * (e.g. Axiom) at client creation; the package stays dependency-free. Never throws to the caller. */
  onFailure?: (failure: NotificationsRequestFailure) => void;
};

export class NotificationsClientError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'NotificationsClientError';
  }
}

/** A single notification-server request failure (after any retries), passed to `onFailure`. */
export type NotificationsRequestFailure = {
  /** The request path, e.g. `/notifications`, `/notifications/query`. */
  path: string;
  /** HTTP status when the app responded; absent for transport/timeout/config failures. */
  status?: number;
  /** True when the failure was transient (5xx/429/transport) and retries were exhausted. */
  retryable: boolean;
  /** Attempts made (0 = failed before the first request, e.g. no endpoint configured). */
  attempts: number;
  message: string;
};

function safeReport(
  onFailure: NotificationsClientConfig['onFailure'],
  failure: NotificationsRequestFailure
) {
  if (!onFailure) return;
  try {
    onFailure(failure);
  } catch {
    // A logger error must never affect the caller or mask the original request failure.
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
    retries: config.retries ?? 2,
    retryBaseMs: config.retryBaseMs ?? 200,
    onFailure: config.onFailure,
  };
}

async function postAttempt(
  url: string,
  body: unknown,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
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
      const retryable = res.status === 429 || res.status >= 500;
      throw new NotificationsClientError(
        `notifications request failed (${res.status})${text ? `: ${text}` : ''}`,
        res.status,
        retryable
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch (err) {
    if (err instanceof NotificationsClientError) throw err;
    // Transport error, abort/timeout, or JSON parse failure — transient; retryable.
    throw new NotificationsClientError((err as Error).message, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

// Reports to `onFailure` exactly once per FINAL failure (config error / non-retryable / retries
// exhausted) — the single choke point every request flows through.
async function post(path: string, body: unknown, config: NotificationsClientConfig): Promise<unknown> {
  let resolved: ReturnType<typeof resolveConfig>;
  try {
    resolved = resolveConfig(config);
  } catch (err) {
    const e = err as NotificationsClientError;
    safeReport(config.onFailure, { path, status: e.status, retryable: false, attempts: 0, message: e.message });
    throw e;
  }
  const { endpoint, token, fetch: fetchImpl, timeoutMs, retries, retryBaseMs, onFailure } = resolved;
  const url = `${endpoint}${path}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postAttempt(url, body, token, fetchImpl, timeoutMs);
    } catch (err) {
      const e = err as NotificationsClientError;
      if (!e.retryable || attempt >= retries) {
        safeReport(onFailure, {
          path,
          status: e.status,
          retryable: e.retryable,
          attempts: attempt + 1,
          message: e.message,
        });
        throw e;
      }
      const backoff = Math.min(retryBaseMs * 2 ** attempt, 2000) + Math.random() * retryBaseMs;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

// Bounds each bulk POST so a large producer run (tens of thousands of rows, each with a potentially large
// `users[]`) can't exceed the app's body limit. The app's DB-write batching is separate.
const BULK_HTTP_BATCH_SIZE = 1000;

/**
 * Build a notifications client bound to `config`. Methods throw `NotificationsClientError` on a
 * non-2xx/transport failure (after retries) — treat delivery as best-effort on hot paths (wrap-and-log).
 */
export function createNotificationsClient(config: NotificationsClientConfig = {}) {
  return {
    createNotification: async (data: CreateNotificationPendingRow): Promise<void> => {
      await post('/notifications', createNotificationPendingRow.parse(data), config);
    },

    // Bulk producer path: recipients already resolved, NO opt-out filter (unlike createNotification).
    createNotificationsBulk: async (rows: CreateNotificationRow[]): Promise<void> => {
      const validated = createNotificationsBulkInput.parse(rows);
      for (let i = 0; i < validated.length; i += BULK_HTTP_BATCH_SIZE) {
        await post('/notifications/bulk', validated.slice(i, i + BULK_HTTP_BATCH_SIZE), config);
      }
    },

    // `createdAt` arrives as an ISO string but callers need a Date (the tRPC cursor is `z.date()`).
    queryNotifications: async (input: QueryNotificationsInput): Promise<NotificationRow[]> => {
      const res = (await post('/notifications/query', input, config)) as Array<
        Omit<NotificationRow, 'createdAt'> & { createdAt: string }
      >;
      return res.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
    },

    // pg returns COUNT(*) as a string; coerce.
    countNotifications: async (input: CountNotificationsInput): Promise<NotificationCategoryCount[]> => {
      const res = (await post('/notifications/count', input, config)) as Array<
        Omit<NotificationCategoryCount, 'count'> & { count: number | string }
      >;
      return res.map((c) => ({ category: c.category, count: Number(c.count) }));
    },

    markNotificationsRead: async (input: MarkReadInput): Promise<void> => {
      await post('/notifications/mark-read', input, config);
    },

    notificationExists: async (input: NotificationExistsInput): Promise<boolean> => {
      const res = (await post('/notifications/exists', input, config)) as { exists?: boolean } | undefined;
      return res?.exists === true;
    },

    cleanupNotifications: async (input: CleanupNotificationsInput): Promise<{ deleted: number }> => {
      const res = (await post('/notifications/cleanup', input, config)) as { deleted?: number } | undefined;
      return { deleted: res?.deleted ?? 0 };
    },
  };
}

export type NotificationsClient = ReturnType<typeof createNotificationsClient>;
