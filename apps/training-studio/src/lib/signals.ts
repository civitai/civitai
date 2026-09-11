import { browser, hostConfig } from '$lib/host';
import { HubConnectionBuilder, HttpTransportType, type HubConnection } from '@microsoft/signalr';

// A single SignalR connection for the tab, opened once from the root layout and shared across navigations.
// Best-effort: the whole app stays fully functional on polling if signals never connect, so every failure
// path here is silent. Not the main app's SharedWorker (one socket across tabs) — this app is single-purpose,
// so a per-tab connection is enough.

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const bound = new Set<string>();
let connection: HubConnection | null = null;

function bind(conn: HubConnection, event: string) {
  if (bound.has(event)) return;
  bound.add(event);
  conn.on(event, (payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  });
}

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/signals-token');
  if (!res.ok) throw new Error('signals token request failed');
  const { accessToken } = (await res.json()) as { accessToken?: string | null };
  if (!accessToken) throw new Error('no signals access token');
  return accessToken;
}

/** Open the connection once. Idempotent, so the layout can call it on every mount. No-op on the server or
 *  when the public signals endpoint isn't configured. The connection is intentionally process-lived — it
 *  outlives navigations and is never `.stop()`-ed; the root layout that opens it only dies on full teardown. */
export function connectSignals() {
  if (!browser || connection) return;
  const endpoint = hostConfig().signalsEndpoint?.replace(/\/+$/, '');
  if (!endpoint) return;

  const conn = new HubConnectionBuilder()
    .withUrl(`${endpoint}/hub`, {
      accessTokenFactory: fetchToken,
      // Load-bearing: with skipNegotiation the WS transport calls accessTokenFactory on every (re)start, so
      // an expired token is re-minted on reconnect. Removing it lets SignalR freeze the first token instead.
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    })
    .withAutomaticReconnect([0, 2, 10, 18, 30, 45, 60, 90])
    .build();
  connection = conn;

  for (const event of handlers.keys()) bind(conn, event);
  conn.start().catch(() => {
    // Signals are an optimization; polling is the source of truth. Swallow so an outage is invisible.
  });
}

/** Subscribe to a named signal event; returns an unsubscribe. Safe to call before `connectSignals()` — the
 *  event binds when the connection opens. `.on` registrations survive automatic reconnects. */
export function onSignal(event: string, handler: Handler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
    if (connection) bind(connection, event);
  }
  set.add(handler);
  return () => set.delete(handler);
}
