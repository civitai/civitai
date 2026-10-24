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
 * Bridge requests an app makes because its viewer did something: generate, estimate (a form being
 * edited), cancel, publish, save, pick, upload, vote, navigate, write storage. Only these count. Reads
 * an app can make on a timer (lists, balances, storage reads, polls), its handshake, size, token and
 * analytics messages, and any type added later do not: an app left open with nobody there must still
 * pause.
 */
export const VIEWER_BRIDGE_TYPES: ReadonlySet<string> = new Set([
  'SUBMIT_WORKFLOW',
  'ESTIMATE_WORKFLOW',
  'ESTIMATE_WORKFLOW_BATCH',
  'CANCEL_WORKFLOW',
  'CANCEL_APP_WORKFLOW',
  'NAVIGATE',
  'REQUEST_SIGN_IN',
  'REQUEST_CONSENT',
  'OPEN_BUZZ_PURCHASE',
  'OPEN_CHECKPOINT_PICKER',
  'OPEN_RESOURCE_PICKER',
  'OPEN_IMAGE_UPLOAD',
  'OPEN_IMAGE_PICKER',
  'OPEN_MEDIA_UPLOAD',
  'SET_USER_CHECKPOINT',
  'APP_STORAGE_SET',
  'APP_STORAGE_DELETE',
  'SHARED_APPEND',
  'SHARED_UPDATE',
  'SHARED_VOTE',
  'SHARED_UNVOTE',
  'SHARED_WITHDRAW',
  'SHARED_REPORT',
  'SAVE_IMAGE',
  'SET_COLLECTION_FOLLOW',
  'SET_ENTITY_REACTION',
  'PUBLISH_GENERATION_OUTPUTS',
  'CREATE_POST_FROM_APP',
  'RUN_TRAINING',
  'RUN_CONFIRMED_STEP',
  'PREPARE_TRAINING_DATASET',
]);

/** Whether a bridge message from the app is a request made for its viewer. */
export function isViewerBridgeMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' && VIEWER_BRIDGE_TYPES.has(type);
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
  now = () => Date.now(),
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
      // The interval first: it is the cheap check, and wheel events come many times a second.
      const t = now();
      if (last !== null && t - last < minIntervalMs) return false;
      if (!isShown()) return false;
      last = t;
      ping().catch(() => undefined);
      return true;
    },
  };
}

/**
 * One MCP `ping` to the app's endpoint (`mcpUrl`), with the user's sandbox token; asks for a fresh
 * token once after a 401. Any authorised request to that endpoint counts as activity, whatever the
 * app answers, so the response is not read.
 */
export async function pingSandbox(
  mcpUrl: string,
  getToken: (opts?: { refresh?: boolean }) => Promise<string>,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  refresh = false
): Promise<void> {
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
  if (res.status === 401 && !refresh) await pingSandbox(mcpUrl, getToken, fetchImpl, true);
}

/**
 * What counts as the user working in the pane itself (outside the app's frame). Not `pointermove`: it
 * can fire with nobody moving the pointer (the pane appearing under a resting one is the likely case),
 * and the phone-layout workspace test saw a ping before any press while it was listened to.
 */
const PANE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'focusin'] as const;

function frameIn(pane: Element, win: unknown): boolean {
  if (!win) return false;
  return Array.from(pane.querySelectorAll('iframe')).some((f) => f.contentWindow === win);
}

/**
 * While `ping` is set, the user's activity in the preview `pane` keeps the app awake (see the top of
 * this file): a pointer press, key, wheel or focus in the pane (a click into the app's frame focuses it), or a
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
