import { useCallback, useEffect, useRef } from 'react';

/**
 * The errors an app's own code reports in its LIVE DEV PREVIEW, kept for App Assistant's
 * app-activity read. Only the dev-tunnel host (`DevTunnelBlockHost`) uses this: it hands the page
 * host an `onBlockError`, and a production mount, which has none, sends nothing.
 *
 * The SDK posts them as `BLOCK_ERROR { message, fatal: false, source, stack?, at }` in dev sessions
 * (≤ 20 a minute, repeats within 10 s dropped). Older SDKs send none. Every field but `message` is
 * optional and each is checked; the server redacts and caps them again.
 */

export const PREVIEW_ERRORS_ENDPOINT = '/api/apps/dev/preview-errors';
/** Reports one POST carries at most (the endpoint's own cap). */
export const PREVIEW_ERRORS_BATCH = 20;
/** Reports waiting to be sent at most; the oldest are dropped past it. */
export const PREVIEW_ERRORS_QUEUE_MAX = 60;
/** How long a report waits for others before the batch is sent. */
export const PREVIEW_ERRORS_FLUSH_MS = 2_000;

const MESSAGE_MAX = 2_000;
const STACK_MAX = 4_000;
const SOURCES = ['error', 'unhandledrejection', 'console'] as const;

export interface PreviewErrorReport {
  message: string;
  fatal: boolean;
  source?: (typeof SOURCES)[number];
  stack?: string;
  at: number;
}

/** A `BLOCK_ERROR` payload as a report, or null when it has no message to keep. */
export function parseBlockErrorReport(raw: unknown, now = Date.now()): PreviewErrorReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.message !== 'string' || value.message.trim().length === 0) return null;
  const source = SOURCES.find((s) => s === value.source);
  return {
    message: value.message.slice(0, MESSAGE_MAX),
    fatal: value.fatal === true,
    ...(source ? { source } : {}),
    ...(typeof value.stack === 'string' && value.stack
      ? { stack: value.stack.slice(0, STACK_MAX) }
      : {}),
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : now,
  };
}

export interface PreviewErrorReporter {
  /** A `BLOCK_ERROR` payload the block posted. */
  report(raw: unknown): void;
  /** Sends what is waiting and stops. */
  close(): void;
}

/**
 * Collects reports and POSTs them in batches for `blockId`. Best effort: a failed POST is dropped,
 * never retried, and nothing it does reaches the block or the page.
 */
export function createPreviewErrorReporter({
  blockId,
  fetchImpl = (...args) => fetch(...args),
  flushMs = PREVIEW_ERRORS_FLUSH_MS,
}: {
  blockId: string;
  fetchImpl?: typeof fetch;
  flushMs?: number;
}): PreviewErrorReporter {
  let queue: PreviewErrorReport[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const send = (keepalive: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length > 0) {
      const batch = queue.slice(0, PREVIEW_ERRORS_BATCH);
      queue = queue.slice(PREVIEW_ERRORS_BATCH);
      void fetchImpl(PREVIEW_ERRORS_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId, errors: batch }),
        keepalive,
      }).catch(() => undefined);
    }
  };

  return {
    report(raw) {
      if (closed) return;
      const report = parseBlockErrorReport(raw);
      if (!report) return;
      queue.push(report);
      if (queue.length > PREVIEW_ERRORS_QUEUE_MAX) queue = queue.slice(-PREVIEW_ERRORS_QUEUE_MAX);
      if (!timer) timer = setTimeout(() => send(false), flushMs);
    },
    close() {
      if (closed) return;
      closed = true;
      send(true);
    },
  };
}

/**
 * The dev-tunnel host's `onBlockError` for `blockId`: one reporter per mount of the app, made in an
 * effect so a remount (and Strict Mode's double effect) gets a fresh one rather than a closed one.
 */
export function useDevPreviewErrorReporter(blockId: string): (raw: unknown) => void {
  const reporter = useRef<PreviewErrorReporter | null>(null);
  useEffect(() => {
    const current = createPreviewErrorReporter({ blockId });
    reporter.current = current;
    return () => {
      current.close();
      if (reporter.current === current) reporter.current = null;
    };
  }, [blockId]);
  return useCallback((raw: unknown) => reporter.current?.report(raw), []);
}
