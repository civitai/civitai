import { useEffect } from 'react';

// The sandbox service pauses an app that has had no traffic on its MCP endpoint for its idle window.
// A user working in the live preview sends none — the preview is served
// through the app's dev tunnel, not that endpoint — so an app in use paused under them. While the
// preview is on screen and the user works in it, the page pings the app's MCP endpoint, which the
// service counts as activity. Nothing else does: a hidden tab, a pane not shown, or no interaction
// for the idle window still lets the app pause.

/** At most one ping per this long. The service records activity at most once a minute anyway. */
export const KEEPALIVE_MIN_INTERVAL_MS = 60_000;

/**
 * Bridge messages an app sends by itself — its handshake, size, credentials, analytics and the
 * repeating poll of a running workflow — so they say nothing about whether someone is using it.
 * Every other bridge message is a request the app makes for its viewer (generate, publish, pick, …).
 */
export const BACKGROUND_BRIDGE_TYPES: ReadonlySet<string> = new Set([
  'BLOCK_HELLO',
  'BLOCK_READY',
  'BLOCK_ERROR',
  'BLOCK_MESSAGE_REJECTED',
  'RESIZE_IFRAME',
  'REQUEST_TOKEN',
  'TRACK_EVENT',
  'POLL_WORKFLOW',
]);

/** Whether a bridge message from the app is a request made for its viewer. */
export function isViewerBridgeMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' && type !== '' && !BACKGROUND_BRIDGE_TYPES.has(type);
}

/** Whether `pane` is on screen: the document is visible and the pane is laid out (not `display: none`). */
export function isPaneShown(pane: Element, doc: Document = document): boolean {
  return doc.visibilityState === 'visible' && pane.getClientRects().length > 0;
}

/**
 * Calls `ping` for the user's activity, at most once per `minIntervalMs`, and only while `isShown()`.
 * Returns whether this activity sent one. A failed ping is dropped: the next activity past the interval
 * tries again.
 */
export function createKeepAlive({
  ping,
  isShown,
  now = Date.now,
  minIntervalMs = KEEPALIVE_MIN_INTERVAL_MS,
}: {
  ping: () => Promise<unknown>;
  isShown: () => boolean;
  now?: () => number;
  minIntervalMs?: number;
}): { activity(): boolean } {
  let last: number | null = null;
  return {
    activity() {
      if (!isShown()) return false;
      const t = now();
      if (last !== null && t - last < minIntervalMs) return false;
      last = t;
      try {
        ping().catch(() => undefined);
      } catch {
        // A ping that throws before it sends is dropped like one that fails.
      }
      return true;
    },
  };
}

/**
 * One MCP `ping` to the app's endpoint (`mcpUrl`), with the user's sandbox token; asks for a fresh
 * token once after a 401. Resolves whether the service answered OK.
 */
export async function pingSandbox(
  mcpUrl: string,
  getToken: (opts?: { refresh?: boolean }) => Promise<string>,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  refresh = false
): Promise<boolean> {
  const token = await getToken(refresh ? { refresh } : undefined);
  const res = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'keepalive', method: 'ping' }),
  });
  if (res.status === 401 && !refresh) return pingSandbox(mcpUrl, getToken, fetchImpl, true);
  return res.ok;
}

/** What counts as the user working in the pane itself (outside the app's frame). */
const PANE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focusin'] as const;

function frameIn(pane: Element, win: unknown): boolean {
  if (!win) return false;
  return Array.from(pane.querySelectorAll('iframe')).some((f) => f.contentWindow === win);
}

/**
 * While `ping` is set, the user's activity in the preview `pane` keeps the app awake (see the top of
 * this file): pointer, key, wheel or focus in the pane (a click into the app's frame focuses it), or a
 * request the app makes for its viewer over the bridge. Pass `ping` null when the app is not running.
 */
export function usePreviewKeepAlive(
  pane: HTMLElement | null,
  ping: (() => Promise<unknown>) | null
): void {
  useEffect(() => {
    if (!pane || !ping) return;
    const keepAlive = createKeepAlive({ ping, isShown: () => isPaneShown(pane) });
    const onActivity = () => void keepAlive.activity();
    // Events inside the app's frame never reach this page; a click into it does focus the frame
    // element, which `focusin` sees.
    const onMessage = (event: MessageEvent) => {
      if (frameIn(pane, event.source) && isViewerBridgeMessage(event.data)) onActivity();
    };
    for (const type of PANE_EVENTS) pane.addEventListener(type, onActivity, { passive: true });
    window.addEventListener('message', onMessage);
    return () => {
      for (const type of PANE_EVENTS) pane.removeEventListener(type, onActivity);
      window.removeEventListener('message', onMessage);
    };
  }, [pane, ping]);
}
