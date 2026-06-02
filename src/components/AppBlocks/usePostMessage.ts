import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface UsePostMessageOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  expectedOrigin: string;
}

interface IncomingMessage {
  type?: string;
  requestId?: string;
  payload?: unknown;
  [key: string]: unknown;
}

interface UsePostMessageResult {
  send: (type: string, payload?: unknown) => void;
  onMessage: <T = unknown>(type: string, handler: (payload: T) => void) => () => void;
}

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 30;
const DEDUP_WINDOW_MS = 5000;

/**
 * L-DEDUP: pull the replay-dedup key out of an incoming message. The SDK
 * transport puts `requestId` inside `payload` (every host handler reads it
 * off `data.payload`), NOT at the top level of the message. The previous
 * implementation read `data.requestId` — always undefined — so the dedup
 * never fired. Read it from `payload.requestId` first, falling back to the
 * top-level shape for forward compatibility. Exported pure so the dedup key
 * resolution is unit-testable without driving the postMessage harness.
 */
export function extractRequestId(data: {
  requestId?: unknown;
  payload?: unknown;
}): string | undefined {
  const fromPayload =
    data.payload &&
    typeof data.payload === 'object' &&
    typeof (data.payload as { requestId?: unknown }).requestId === 'string'
      ? (data.payload as { requestId: string }).requestId
      : undefined;
  if (fromPayload) return fromPayload;
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}

/**
 * Typed postMessage send/receive with security rails:
 *   - Drops messages from origins other than `expectedOrigin`
 *   - Deduplicates by `requestId` inside a 5-second window
 *   - Rate-limits incoming messages to 30/sec (excess is dropped)
 */
export function usePostMessage(opts: UsePostMessageOptions): UsePostMessageResult {
  const { iframeRef, expectedOrigin } = opts;
  const handlersRef = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map());
  const recentTimestampsRef = useRef<number[]>([]);
  const seenRequestIdsRef = useRef<Map<string, number>>(new Map());

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (!expectedOrigin) return; // misconfigured iframe.src — drop everything
      if (event.origin !== expectedOrigin) return;
      // event.source check: origin alone is spoofable across same-origin iframes
      // (two installs from the same publisher on one page can postMessage at
      // each other and forge a BLOCK_ERROR/BLOCK_READY for a sibling). The
      // window-identity check pins us to OUR iframe specifically. See PR audit C6.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as IncomingMessage | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      const now = Date.now();

      // Subscriber lookup before rate-limit/dedup budget consumption. A flood
      // of {type:'GARBAGE'} with no handler shouldn't burn the 30/s budget and
      // lock out legitimate BLOCK_ERROR reporting.
      const subscribers = handlersRef.current.get(data.type);
      if (!subscribers || subscribers.size === 0) return;

      // L-DEDUP: read the requestId from where the SDK actually puts it
      // (inside `payload`), not the always-undefined top-level `requestId`.
      const payloadRequestId = extractRequestId(data);
      if (typeof payloadRequestId === 'string') {
        const seenAt = seenRequestIdsRef.current.get(payloadRequestId);
        if (seenAt != null && now - seenAt < DEDUP_WINDOW_MS) {
          return;
        }
        // Cap the dedup map so a flood of unique requestIds can't grow it.
        if (seenRequestIdsRef.current.size >= 256) {
          const oldestKey = seenRequestIdsRef.current.keys().next().value;
          if (oldestKey != null) seenRequestIdsRef.current.delete(oldestKey);
        }
        seenRequestIdsRef.current.set(payloadRequestId, now);
        // GC stale entries
        for (const [k, v] of seenRequestIdsRef.current.entries()) {
          if (now - v >= DEDUP_WINDOW_MS) seenRequestIdsRef.current.delete(k);
        }
      }

      // Note: do NOT name this local `window` — it would shadow the global
      // and any future `window.*` reference inside this closure would bind
      // to the array instead. M-8 from the PR audit.
      const recentWindow = recentTimestampsRef.current.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
      );
      if (recentWindow.length >= RATE_LIMIT_MAX_MESSAGES) {
        // eslint-disable-next-line no-console
        console.warn('[AppBlocks] postMessage rate limit exceeded; dropping message');
        return;
      }
      recentWindow.push(now);
      recentTimestampsRef.current = recentWindow;

      for (const handler of subscribers) handler(data.payload);
    },
    [expectedOrigin, iframeRef]
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const send = useCallback(
    (type: string, payload?: unknown) => {
      if (!expectedOrigin) return; // refuse to post to "*"
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage({ type, payload }, expectedOrigin);
    },
    [iframeRef, expectedOrigin]
  );

  const onMessage = useCallback(
    <T = unknown>(type: string, handler: (payload: T) => void) => {
      const bag = handlersRef.current.get(type) ?? new Set<(payload: unknown) => void>();
      const cast = handler as (payload: unknown) => void;
      bag.add(cast);
      handlersRef.current.set(type, bag);
      return () => {
        const current = handlersRef.current.get(type);
        if (!current) return;
        current.delete(cast);
        if (current.size === 0) handlersRef.current.delete(type);
      };
    },
    []
  );

  return { send, onMessage };
}
