// A send recorder for an app that has no ClickHouse access of its own (the auth hub, the moderator
// app): each send row is POSTed to the main app's internal route, which inserts it. The row is the
// tags and our send id only (EmailSendRecord), never an address or content.
import type { EmailSendRecord, EmailSendRecorder } from './client';

/** The main app's route that takes send rows from the other apps. */
export const EMAIL_EVENTS_INTERNAL_PATH = '/api/internal/email-events';

/** How long one POST may run before it is aborted, so a slow main app holds nothing open. */
export const REMOTE_RECORDER_TIMEOUT_MS = 2000;

export interface RemoteSendRecorderOptions {
  /** The main app's base URL, e.g. https://civitai.com. */
  baseUrl: string;
  /** The service credential the route accepts, sent as the Bearer. */
  token: string;
  /** Told of a failed POST (a status or an error), for the app's own log. Never an address. */
  onError?: (reason: string) => void;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The recorder, or null when either the base URL or the token is missing (nothing is recorded, and
 * nothing is sent anywhere). The send never waits on it (the transport starts it and moves on), and
 * it never throws or rejects: a failed POST costs one missing row.
 */
export function createRemoteSendRecorder({
  baseUrl,
  token,
  onError,
  timeoutMs = REMOTE_RECORDER_TIMEOUT_MS,
  fetch: fetchImpl = globalThis.fetch,
}: RemoteSendRecorderOptions): EmailSendRecorder | null {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base || !token?.trim()) return null;
  const url = `${base}${EMAIL_EVENTS_INTERNAL_PATH}`;
  return async (record: EmailSendRecord) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sends: [record] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drained either way, so a run of refusals never holds sockets open.
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) onError?.(`status ${res.status}`);
    } catch (err) {
      onError?.((err as Error)?.name ?? 'error');
    }
  };
}
