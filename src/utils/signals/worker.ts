import type { HubConnection } from '@microsoft/signalr';
import {
  HttpTransportType,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { env } from '~/env/client';
import type {
  SignalConnectionState,
  SignalEventEntry,
  SignalLogEntry,
  SignalServerPingResult,
  SignalStatus,
  SignalTopicMethod,
  SignalTopicStatus,
  SignalWorkerStatus,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from './types';
import { PORT_STALE_AFTER_MS, SIGNALS_WORKER_VERSION } from './types';
import { BackoffRetry, HUB_CONNECT_BACKOFF, HUB_STABLE_CONNECTION_MS } from './backoff';
import { EventEmitter } from './utils';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}

const _self: SharedWorkerGlobalScope = self as any;

// --------------------------------
// Structured logging ring buffer
// --------------------------------
const LOG_MAX = 500;
const logBuffer: SignalLogEntry[] = [];
let verboseLogging = false;

// --------------------------------
// Recent signals ring buffer
// --------------------------------
const SIGNALS_MAX = 50;
const signalsBuffer: SignalEventEntry[] = [];

function workerLog(type: string, detail?: string) {
  const entry: SignalLogEntry = { ts: Date.now(), type, detail };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  if (verboseLogging) console.log(`[signals] ${type}`, detail ?? '');
}

// --------------------------------
// State
// --------------------------------
let connectionState: SignalConnectionState = { state: null };
let connectedUserId: number | null = null;
// Most recently fetched token any tab sent, read on every (re)connect attempt, so a tab that fetched a
// fresh token (e.g. one reloaded during an outage) is used by the next retry. Signals tokens do not
// expire. Ranked by fetch time, not arrival — an old tab re-sending its page-load token must not
// displace a newer one.
let latestToken = { token: '', fetchedAt: 0 };
let connection: HubConnection | null = null;
const events: Record<string, (data: unknown) => void> = {};
let lastEventReceivedAt: number | null = null;
let lastServerPongAt: number | null = null;
// Anything proving the server still talks to us: connect, signal, pong, successful invoke.
let lastServerActivityAt: number | null = null;
const startedAt = Date.now();

function markServerActivity() {
  lastServerActivityAt = Date.now();
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${label} timeout`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// --------------------------------
// Port tracking
// --------------------------------
const ports = new Map<
  MessagePort,
  { connectedAt: number; lastMessageAt: number; stale: boolean }
>();

// A tab that crashes or is discarded never sends `beforeunload`, and the keep-alive would otherwise
// hold its topics for the worker's whole life. A merely frozen tab gets `port:reset` when it wakes.
setInterval(() => {
  const now = Date.now();
  for (const [port, meta] of ports) {
    if (meta.stale || now - meta.lastMessageAt < PORT_STALE_AFTER_MS) continue;
    meta.stale = true;
    const topics = [...(portTopics.get(port)?.keys() ?? [])];
    workerLog('port:stale', `${topics.length} topic(s) dropped`);
    void releaseTopics(port, topics);
  }
}, 60_000);

// --------------------------------
// Topic tracking
// --------------------------------
// One hub subscription per connection is shared by every tab, so a topic stays subscribed while
// any tab wants it.
const portTopics = new Map<MessagePort, Map<string, boolean>>();

// Hub drops a topic subscription 60s after the last subscribe call. The refresh runs here rather
// than in the tabs because hidden tabs throttle timers to ~1/min, which overshoots the TTL.
const TOPIC_KEEP_ALIVE_INTERVAL = 50_000;
const TOPIC_INVOKE_TIMEOUT = 10_000;

function getWantedTopics() {
  const wanted = new Map<string, boolean>();
  for (const topics of portTopics.values()) {
    for (const [topic, notify] of topics) wanted.set(topic, wanted.get(topic) || notify);
  }
  return wanted;
}

function subscribeTopic(topic: string) {
  const notify = getWantedTopics().get(topic);
  return topicInvoke(notify ? 'subscribeNotify' : 'subscribe', topic);
}

// Subscribe invokes still awaiting the hub, per topic. A timed-out invoke keeps running, so the
// keep-alive skips these rather than queueing more calls behind a slow hub.
// An invoke the hub never answers is treated as lost after one interval, or its topic would never
// be refreshed again.
const pendingSubscribes = new Map<string, { count: number; startedAt: number }>();

function isSubscribePending(topic: string) {
  const pending = pendingSubscribes.get(topic);
  return !!pending && Date.now() - pending.startedAt < TOPIC_KEEP_ALIVE_INTERVAL;
}

function resubscribeAll(reason: string) {
  const wanted = getWantedTopics();
  if (!wanted.size) return;
  const topics = [...wanted.keys()].filter(
    (topic) => reason !== 'keep-alive' || !isSubscribePending(topic)
  );
  workerLog(
    'topic:resubscribe-all',
    `${topics.length}/${wanted.size} topic(s), ${reason}${
      topics.length < wanted.size ? ' (rest still pending)' : ''
    }`
  );
  for (const topic of topics) void subscribeTopic(topic);
}

function onConnected() {
  markServerActivity();
  startStalenessCheck();
  // Group memberships belong to the SignalR connection, so a new connection starts with none.
  resubscribeAll('connected');
}

async function releaseTopics(port: MessagePort, topics: string[]) {
  const own = portTopics.get(port);
  for (const topic of topics) {
    own?.delete(topic);
    if (getWantedTopics().has(topic)) workerLog('topic:unsubscribe:kept', `${topic} (other tab)`);
    else await topicInvoke('unsubscribe', topic);
  }
}

setInterval(() => {
  if (connectionState.state === 'connected') resubscribeAll('keep-alive');
}, TOPIC_KEEP_ALIVE_INTERVAL);

// --------------------------------
// Staleness heartbeat
// --------------------------------
const STALENESS_CHECK_INTERVAL = 60_000; // check every 60s
const STALENESS_THRESHOLD = 3 * 60_000; // 3 minutes without server activity = stale
const SERVER_PING_TIMEOUT = 5_000; // 5s timeout for server ping

async function serverPing(): Promise<SignalServerPingResult> {
  const startedPingAt = Date.now();
  if (!connection || connection.state !== HubConnectionState.Connected) {
    return {
      ok: false,
      ms: 0,
      error: `hub not connected (${connection?.state ?? 'no connection'})`,
    };
  }
  try {
    await withTimeout(connection.invoke('Ping'), SERVER_PING_TIMEOUT, 'ping');
    lastServerPongAt = Date.now();
    markServerActivity();
    workerLog('heartbeat:pong');
    return { ok: true, ms: lastServerPongAt - startedPingAt };
  } catch (e) {
    const error = (e as Error).message;
    const ms = Date.now() - startedPingAt;
    // A server that answers with an error (e.g. no `Ping` hub method) still proves the socket is
    // alive. Only silence or a closed connection means a zombie; treating errors as dead made the
    // heartbeat drop healthy idle connections.
    const answered =
      !(e instanceof TimeoutError) && connection?.state === HubConnectionState.Connected;
    if (answered) {
      markServerActivity();
      workerLog('heartbeat:answered-with-error', error);
      return { ok: true, ms, error };
    }
    workerLog('heartbeat:failed', error);
    return { ok: false, ms, error };
  }
}

// Set while the worker stops the connection on purpose, so `onclose` does not treat it as a drop.
// SignalR fires `onclose` before `stop()` resolves.
let stoppingDeliberately = false;

/** Stop the connection and report 'closed'; every tab answers with `connection:init`. */
async function closeConnection(message: string) {
  stoppingDeliberately = true;
  try {
    await connection?.stop();
  } catch {
    // ignore stop errors
  } finally {
    stoppingDeliberately = false;
  }
  // setConnectionState's listener handles nulling `connection` on 'closed'
  setConnectionState({ state: 'closed', message });
}

async function stalenessCheck() {
  if (!connection || connectionState.state !== 'connected' || lastServerActivityAt === null) return;

  const silentMs = Date.now() - lastServerActivityAt;
  if (silentMs < STALENESS_THRESHOLD) return;

  workerLog(
    'heartbeat:stale',
    `No server activity for ${Math.round(silentMs / 1000)}s, pinging server`
  );

  const { ok } = await serverPing();
  if (!ok) {
    workerLog('heartbeat:zombie', 'Server ping failed on stale connection, forcing reconnect');
    // Handled like any other drop: 'reconnecting', then the backoff retry (see `onclose`).
    try {
      await connection?.stop();
    } catch {
      // ignore stop errors
    }
  }
}

let stalenessInterval: ReturnType<typeof setInterval> | null = null;
function startStalenessCheck() {
  if (stalenessInterval) clearInterval(stalenessInterval);
  stalenessInterval = setInterval(stalenessCheck, STALENESS_CHECK_INTERVAL);
}

// --------------------------------
// Event emitter
// --------------------------------
const emitter = new EventEmitter<{
  eventReceived: { target: string; payload: any };
  stateChanged: SignalConnectionState;
  topicStatus: Omit<SignalTopicStatus, 'type'>;
}>();

function setConnectionState(args: { state: SignalStatus; message?: string }) {
  emitter.emit('stateChanged', args);
}

function broadcastCurrentConnectionState() {
  for (const port of ports.keys()) {
    port.postMessage({ type: 'connection:state', ...connectionState });
  }
}

emitter.on('stateChanged', ({ state, message }) => {
  const prev = connectionState.state;
  connectionState = { state, message };
  if (state === 'closed') connection = null;
  workerLog('state:change', `${prev} → ${state}${message ? ` (${message})` : ''}`);
});

function getWorkerStatus(): SignalWorkerStatus {
  return {
    version: SIGNALS_WORKER_VERSION,
    connectionState: connectionState.state,
    connectionMessage: connectionState.message,
    hubState: connection?.state ?? null,
    connectionId: connection?.connectionId ?? null,
    connectedUserId,
    connectRetry: connectRetry.getStatus(),
    portCount: ports.size,
    registeredEvents: Object.keys(events),
    topics: Object.fromEntries(getWantedTopics()),
    lastEventReceivedAt,
    lastServerPongAt,
    lastServerActivityAt,
    logEntries: [...logBuffer],
    recentSignals: [...signalsBuffer],
    uptime: Date.now() - startedAt,
  };
}

// --------------------------------
// Connection
// --------------------------------
// The ONE retry mechanism for the hub: every `start()` — the first, after a failed attempt, and after
// a lost connection — goes through this schedule. (SignalR's own automatic reconnect is deliberately
// not used: two mechanisms meant two schedules and a hand-over between them.) Each tab sends
// `connection:init` on load and on every 'closed'; those wait for the next scheduled attempt rather
// than adding attempts of their own.
const connectRetry = new BackoffRetry(() => void connect(), HUB_CONNECT_BACKOFF);
// Pending while the current connection is younger than HUB_STABLE_CONNECTION_MS.
let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;

function resetConnectBackoff() {
  if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
  stableConnectionTimer = null;
  connectRetry.reset();
}

/** The backoff resets only once the new connection has stayed up; see HUB_STABLE_CONNECTION_MS. */
function onConnectionUp() {
  if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
  stableConnectionTimer = setTimeout(() => {
    stableConnectionTimer = null;
    connectRetry.succeeded();
  }, HUB_STABLE_CONNECTION_MS);
}

/**
 * A lost connection is a failed attempt: the next one waits for the backoff, starting at its first
 * (0.5-3s, jittered) step after a stable connection. A connection that was not yet stable never
 * reset the count, so a hub that keeps accepting and dropping connections climbs the schedule.
 * The worker reports 'reconnecting' until an attempt succeeds, however long that takes.
 */
function onConnectionDropped(error?: Error) {
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
    workerLog('connection:unstable', `dropped within ${HUB_STABLE_CONNECTION_MS / 1000}s`);
  }
  connectRetry.failed();
  setConnectionState({ state: 'reconnecting', message: JSON.stringify(error) });
}

/** Ask for a `start()`; a no-op unless the connection is down, so a connected worker schedules nothing. */
function requestConnect() {
  if (connection && connection.state !== HubConnectionState.Disconnected) return;
  connectRetry.request();
}

async function connect() {
  if (!connection) {
    setConnectionState({ state: 'closed', message: 'missing SignalR connection' });
    return;
  }
  if (connection.state !== HubConnectionState.Disconnected) return;
  try {
    workerLog('connection:starting');
    await connection.start();
    onConnectionUp();
    setConnectionState({ state: 'connected' });
    onConnected();
  } catch (err) {
    connectRetry.failed();
    const { failures, nextAttemptAt } = connectRetry.getStatus();
    workerLog(
      'connection:start-failed',
      `${(err as Error).message}; attempt ${failures}, next in ${
        nextAttemptAt ? Math.round((nextAttemptAt - Date.now()) / 1000) : '?'
      }s`
    );
  }
}

const buildHubConnection = async ({
  userId,
  token,
  tokenFetchedAt,
}: {
  token: string;
  userId: number;
  tokenFetchedAt: number;
}) => {
  const userSwitch = userId !== connectedUserId;
  if (userSwitch || tokenFetchedAt >= latestToken.fetchedAt) {
    latestToken = { token, fetchedAt: tokenFetchedAt };
  }
  if (userSwitch) {
    workerLog('connection:user-switch', `${connectedUserId} → ${userId}`);
    connectedUserId = userId;
    if (connection) {
      (connection as any)._closedCallbacks = [];
      await connection.stop();
      connection = null;
    }
    resetConnectBackoff();
  }

  if (connection) return connection;

  workerLog('connection:building');

  connection = new HubConnectionBuilder()
    .withUrl(`${env.NEXT_PUBLIC_SIGNALS_ENDPOINT}/hub`, {
      accessTokenFactory: () => latestToken.token,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      logger: {
        log: (level, message) => {
          const logLevel = LogLevel[level] ?? 'unknown';
          workerLog(`signalr:${logLevel}`, message);
        },
      },
    })
    .configureLogging(LogLevel.Trace)
    .build();

  // Without automatic reconnect, SignalR closes the connection on any loss. The object is kept and
  // restarted by the backoff retry, with whatever token the worker holds then (`latestToken`).
  connection.onclose((error) => {
    workerLog('connection:closed', error?.message);
    if (stoppingDeliberately) return;
    onConnectionDropped(error);
  });
  connection.on('Pong', () => {
    lastServerPongAt = Date.now();
    markServerActivity();
    workerLog('server:pong');
  });

  for (const [target, event] of Object.entries(events)) {
    connection.on(target, event);
  }
  return connection;
};

async function registerEvents(targets: string[]) {
  for (const target of targets) {
    if (!events[target]) {
      events[target] = (payload) => {
        lastEventReceivedAt = Date.now();
        markServerActivity();
        signalsBuffer.push({ ts: lastEventReceivedAt, target, payload });
        if (signalsBuffer.length > SIGNALS_MAX) signalsBuffer.shift();
        emitter.emit('eventReceived', { target, payload });
      };
      if (connection) {
        connection.on(target, events[target]);
      }
      workerLog('event:registered', target);
    }
  }
}

// --------------------------------
// Topic operations with error handling
// --------------------------------
async function topicInvoke(method: SignalTopicMethod, topic: string) {
  let ok = false;
  let reason: string | undefined;
  try {
    if (!connection) {
      reason = 'no-connection';
      workerLog(`topic:${method}:no-connection`, topic);
    } else {
      const invocation = connection.invoke(method, topic);
      if (method !== 'unsubscribe') {
        const count = (pendingSubscribes.get(topic)?.count ?? 0) + 1;
        pendingSubscribes.set(topic, { count, startedAt: Date.now() });
        void invocation
          .catch(() => undefined)
          .finally(() => {
            const pending = pendingSubscribes.get(topic);
            if (pending && pending.count > 1) pending.count -= 1;
            else pendingSubscribes.delete(topic);
          });
      }
      await withTimeout(invocation, TOPIC_INVOKE_TIMEOUT, method);
      ok = true;
      markServerActivity();
      workerLog(`topic:${method}:ok`, topic);
    }
  } catch (e) {
    reason = e instanceof TimeoutError ? 'timeout' : (e as Error).message;
    workerLog(`topic:${method}:failed`, `${topic}: ${reason}`);
  }
  emitter.emit('topicStatus', { topic, method, ok, reason });
}

// --------------------------------
// Port management
// --------------------------------
const start = async (port: MessagePort) => {
  if (!port.postMessage) return;
  if (port.start) port.start();

  ports.set(port, { connectedAt: Date.now(), lastMessageAt: Date.now(), stale: false });
  const topics = new Map<string, boolean>();
  portTopics.set(port, topics);
  workerLog('port:connected', `total: ${ports.size}`);

  const postMessage = (req: WorkerOutgoingMessage) => port.postMessage(req);
  postMessage({ type: 'worker:ready', version: SIGNALS_WORKER_VERSION });
  postMessage({ type: 'connection:state', ...connectionState });

  const emitterOffHandlers = [
    emitter.on('stateChanged', ({ state, message }) =>
      postMessage({ type: 'connection:state', state, message })
    ),
    emitter.on('eventReceived', ({ target, payload }) =>
      postMessage({ type: 'event:received', target, payload })
    ),
    emitter.on('topicStatus', (status) => postMessage({ type: 'topic:status', ...status })),
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    const portMeta = ports.get(port);
    if (portMeta) {
      portMeta.lastMessageAt = Date.now();
      if (portMeta.stale) {
        portMeta.stale = false;
        workerLog('port:revived');
        postMessage({ type: 'port:reset' });
      }
    }

    if (data.type === 'connection:init') {
      workerLog('msg:connection:init', `userId: ${data.userId}`);
      await buildHubConnection({
        token: data.token,
        userId: data.userId,
        tokenFetchedAt: data.tokenFetchedAt,
      });
      // A newer token needs no attempt of its own: every attempt reads `latestToken`.
      requestConnect();
    } else if (data.type === 'event:register') {
      registerEvents([data.target]);
    } else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      ports.delete(port);
      workerLog('port:disconnected', `total: ${ports.size}`);
      port.close();
      await releaseTopics(port, [...topics.keys()]);
      portTopics.delete(port);
    } else if (data.type === 'ping') {
      postMessage({ type: 'pong' });
      broadcastCurrentConnectionState();
    } else if (data.type === 'topic:register' || data.type === 'topic:registerNotify') {
      topics.set(data.topic, data.type === 'topic:registerNotify');
      await subscribeTopic(data.topic);
    } else if (data.type === 'topic:unsubscribe') {
      await releaseTopics(port, [data.topic]);
    } else if (data.type === 'send') {
      try {
        await connection?.send(data.target, data.args);
      } catch (e) {
        workerLog('send:failed', `${data.target}: ${(e as Error).message}`);
      }
    } else if (data.type === 'debug:dump') {
      postMessage({ type: 'debug:dump', data: getWorkerStatus() });
    } else if (data.type === 'debug:toggle-verbose') {
      verboseLogging = !verboseLogging;
      workerLog('debug:verbose', `${verboseLogging}`);
    } else if (data.type === 'debug:server-ping') {
      postMessage({ type: 'debug:server-pong', ...(await serverPing()) });
    } else if (data.type === 'debug:reconnect') {
      workerLog('debug:reconnect');
      // A manual reconnect is the one attempt that skips the backoff.
      resetConnectBackoff();
      await closeConnection('Forced reconnect (debug)');
    }
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
