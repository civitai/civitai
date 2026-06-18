import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface UsePostMessageOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  expectedOrigin: string;
  /**
   * Opt-in opaque-origin transport for sandboxed frames WITHOUT
   * `allow-same-origin` (unverified/external blocks). Such a frame runs at an
   * opaque origin: `event.origin === 'null'` on everything it sends, and a
   * `postMessage` to it only reaches the frame with `targetOrigin = '*'`.
   *
   * Default `false` → behavior is byte-identical to before this option
   * existed: inbound is pinned to `expectedOrigin`, outbound posts to
   * `expectedOrigin`, and a missing `expectedOrigin` refuses to post.
   *
   * When `true`:
   *   - Inbound accepts `event.origin === 'null'` (the opaque origin) in
   *     addition to a matching `expectedOrigin`. It does NOT accept arbitrary
   *     non-null origins. The `event.source === iframe.contentWindow`
   *     source-window pin (origin-independent) remains the authenticating
   *     guard — origin cannot be pinned for an opaque frame.
   *   - Outbound posts with `targetOrigin = '*'` (the only value a null-origin
   *     recipient accepts). This is safe here: the message is delivered solely
   *     to THIS one host-controlled, sandboxed iframe's `contentWindow`, whose
   *     `src` the host sets — `'*'` is the standard pattern for messaging your
   *     own sandboxed frame, and the only listener is that frame.
   */
  opaqueOrigin?: boolean;
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
 * Pure origin acceptance check for an inbound message, factored out so the
 * pinned-vs-opaque branch is unit-testable without the postMessage harness.
 *
 *   - Non-opaque (default): accept ONLY when `eventOrigin === expectedOrigin`
 *     and `expectedOrigin` is truthy. Byte-identical to the original guard.
 *   - Opaque mode: ALSO accept the literal opaque origin `'null'` (a sandboxed
 *     frame with no `allow-same-origin`). A matching `expectedOrigin` is still
 *     accepted as a belt; arbitrary non-null origins are still rejected. The
 *     real sender authentication in opaque mode is the `event.source` window
 *     pin enforced by the caller — NOT this origin check.
 */
export function isInboundOriginAccepted(
  eventOrigin: string,
  expectedOrigin: string,
  opaqueOrigin: boolean
): boolean {
  if (opaqueOrigin && eventOrigin === 'null') return true;
  if (!expectedOrigin) return false;
  return eventOrigin === expectedOrigin;
}

/**
 * Pure outbound `targetOrigin` resolution for `send`, factored out so the
 * pinned-vs-opaque branch is unit-testable.
 *
 *   - Opaque mode → `'*'`: the recipient runs at an opaque origin ('null') and
 *     `'*'` is the ONLY targetOrigin that reaches it (a real origin throws
 *     "target origin … does not match recipient origin 'null'"). Safe because
 *     the message is delivered solely to the one host-controlled sandboxed
 *     iframe's contentWindow (the caller still pins the recipient window).
 *   - Pinned mode with a truthy `expectedOrigin` → that origin (byte-identical
 *     to the original behavior).
 *   - Pinned mode with no `expectedOrigin` → `null` ("refuse to post"): the
 *     original code returned early rather than fall back to `'*'`.
 */
export function resolveOutboundTargetOrigin(
  expectedOrigin: string,
  opaqueOrigin: boolean
): string | null {
  if (opaqueOrigin) return '*';
  if (!expectedOrigin) return null;
  return expectedOrigin;
}

/**
 * Typed postMessage send/receive with security rails:
 *   - Drops messages from origins other than `expectedOrigin` (or the opaque
 *     `'null'` origin when `opaqueOrigin` is set — see UsePostMessageOptions)
 *   - Pins the sender to OUR iframe's `contentWindow` (the authenticating
 *     guard, origin-independent — the only sender check in opaque mode)
 *   - Deduplicates by `requestId` inside a 5-second window
 *   - Rate-limits incoming messages to 30/sec (excess is dropped)
 */
export function usePostMessage(opts: UsePostMessageOptions): UsePostMessageResult {
  const { iframeRef, expectedOrigin, opaqueOrigin = false } = opts;
  const handlersRef = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map());
  const recentTimestampsRef = useRef<number[]>([]);
  const seenRequestIdsRef = useRef<Map<string, number>>(new Map());

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Origin acceptance: pinned to `expectedOrigin` by default; in
      // opaqueOrigin mode the sandboxed (no allow-same-origin) frame's
      // `'null'` origin is accepted too. A missing expectedOrigin in non-opaque
      // mode still drops everything (misconfigured iframe.src). The
      // event.source window pin below is the authenticating guard either way.
      if (!isInboundOriginAccepted(event.origin, expectedOrigin, opaqueOrigin)) return;
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
    [expectedOrigin, iframeRef, opaqueOrigin]
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const send = useCallback(
    (type: string, payload?: unknown) => {
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      const targetOrigin = resolveOutboundTargetOrigin(expectedOrigin, opaqueOrigin);
      if (targetOrigin === null) return; // pinned mode, no origin: refuse to post
      iframe.contentWindow.postMessage({ type, payload }, targetOrigin);
    },
    [iframeRef, expectedOrigin, opaqueOrigin]
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
