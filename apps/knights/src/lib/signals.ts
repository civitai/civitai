import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { HubConnectionBuilder, HttpTransportType, type HubConnection } from '@microsoft/signalr';

// One SignalR connection per tab, opened by /play and kept for the life of the tab. Best effort: /play works the same without
// it, so every failure here is silent.

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const bound = new Set<string>();
const topics = new Map<string, number>();
// Topics the hub has confirmed on the current connection; `topics` is only what was asked for.
const confirmed = new Set<string>();
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

const invoke = (method: 'subscribe' | 'unsubscribe', topic: string) => {
  const conn = connection;
  if (conn?.state !== 'Connected') return;
  conn.invoke(method, topic).then(
    () => {
      // A confirmation that lands after the topic was left, or on a connection since dropped, does not count.
      if (
        method === 'subscribe' &&
        topics.has(topic) &&
        connection === conn &&
        conn.state === 'Connected'
      ) {
        confirmed.add(topic);
      }
    },
    () => {}
  );
};

/** Opens the connection once; a no-op on the server or without `PUBLIC_SIGNALS_ENDPOINT`. */
export function connectSignals() {
  if (!browser || connection) return;
  const endpoint = env.PUBLIC_SIGNALS_ENDPOINT?.replace(/\/+$/, '');
  if (!endpoint) return;

  const conn = new HubConnectionBuilder()
    .withUrl(`${endpoint}/hub`, {
      accessTokenFactory: fetchToken,
      // With skipNegotiation the WebSocket transport asks for a token on every (re)start, so an expired one is re-minted.
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    })
    // Every retry mints a token: a sub-second schedule would hammer the token route.
    .withAutomaticReconnect([0, 2, 10, 18, 30, 45, 60, 90].map((seconds) => seconds * 1000))
    .build();
  connection = conn;
  for (const event of handlers.keys()) bind(conn, event);
  // Topic subscriptions live on the hub's side of the connection, so a reconnected one asks for them again.
  const resubscribe = () => {
    for (const topic of topics.keys()) invoke('subscribe', topic);
  };
  conn.onreconnecting(() => confirmed.clear());
  conn.onreconnected(resubscribe);
  // A connection that failed to open, or gave up reconnecting, is forgotten so the next /play visit tries again.
  const forget = () => {
    if (connection === conn) {
      connection = null;
      bound.clear();
      confirmed.clear();
    }
  };
  conn.onclose(forget);
  conn.start().then(resubscribe, forget);
}

/** Subscribes to a named event; returns an unsubscribe. Safe before `connectSignals()`: it binds when the connection opens. */
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

/** Joins a topic for as long as the returned function is not called; counted, so two callers can share one topic. */
export function joinTopic(topic: string): () => void {
  const count = (topics.get(topic) ?? 0) + 1;
  topics.set(topic, count);
  if (count === 1) invoke('subscribe', topic);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const remaining = (topics.get(topic) ?? 1) - 1;
    if (remaining > 0) return void topics.set(topic, remaining);
    topics.delete(topic);
    confirmed.delete(topic);
    invoke('unsubscribe', topic);
  };
}

/** The connection's state right now: open, and every one of `wanted` confirmed by the hub. Read at a vote's press, for logs. */
export function signalsAt(wanted: readonly string[]): { connected: boolean; subscribed: boolean } {
  const connected = connection?.state === 'Connected';
  return { connected, subscribed: connected && wanted.every((topic) => confirmed.has(topic)) };
}
