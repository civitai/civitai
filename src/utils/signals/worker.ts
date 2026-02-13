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
  SignalLogEntry,
  SignalStatus,
  SignalWorkerStatus,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from './types';
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
let connection: HubConnection | null = null;
const events: Record<string, (data: unknown) => void> = {};
let lastEventReceivedAt: number | null = null;
let lastServerPongAt: number | null = null;
const startedAt = Date.now();

// --------------------------------
// Port tracking
// --------------------------------
const ports = new Map<MessagePort, { connectedAt: number; lastMessageAt: number }>();

// --------------------------------
// Staleness heartbeat
// --------------------------------
const STALENESS_CHECK_INTERVAL = 60_000; // check every 60s
const STALENESS_THRESHOLD = 3 * 60_000; // 3 minutes with no events = stale
const SERVER_PING_TIMEOUT = 5_000; // 5s timeout for server ping

async function serverPing(): Promise<boolean> {
  if (!connection || connection.state !== HubConnectionState.Connected) return false;
  try {
    await Promise.race([
      connection.invoke('Ping'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), SERVER_PING_TIMEOUT)
      ),
    ]);
    lastServerPongAt = Date.now();
    workerLog('heartbeat:pong');
    return true;
  } catch (e) {
    workerLog('heartbeat:failed', (e as Error).message);
    return false;
  }
}

async function stalenessCheck() {
  if (!connection || connectionState.state !== 'connected') return;

  // If we've never received an event, skip staleness check (may still be initializing)
  if (lastEventReceivedAt === null) return;

  const timeSinceLastEvent = Date.now() - lastEventReceivedAt;
  if (timeSinceLastEvent < STALENESS_THRESHOLD) return;

  workerLog(
    'heartbeat:stale',
    `No events for ${Math.round(timeSinceLastEvent / 1000)}s, pinging server`
  );

  const alive = await serverPing();
  if (!alive) {
    workerLog('heartbeat:zombie', 'Server ping failed on stale connection, forcing reconnect');
    try {
      await connection?.stop();
    } catch {
      // ignore stop errors
    }
    // setConnectionState's listener handles nulling `connection` on 'closed'
    setConnectionState({
      state: 'closed',
      message: 'Zombie connection detected (server ping failed)',
    });
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
  pong: undefined;
  debugDump: SignalWorkerStatus;
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
    connectionState: connectionState.state,
    connectedUserId,
    portCount: ports.size,
    registeredEvents: Object.keys(events),
    lastEventReceivedAt,
    lastServerPongAt,
    logEntries: [...logBuffer],
    uptime: Date.now() - startedAt,
  };
}

// --------------------------------
// Connection
// --------------------------------
async function connect() {
  if (!connection) {
    setConnectionState({ state: 'closed', message: 'missing SignalR connection' });
    return;
  }
  if (connection.state !== HubConnectionState.Disconnected) return;
  try {
    workerLog('connection:starting');
    await connection.start();
    setConnectionState({ state: 'connected' });
    startStalenessCheck();
  } catch (err) {
    workerLog('connection:start-failed', (err as Error).message);
    setTimeout(() => connect(), 5000);
  }
}

const buildHubConnection = async ({ userId, token }: { token: string; userId: number }) => {
  if (userId !== connectedUserId) {
    workerLog('connection:user-switch', `${connectedUserId} → ${userId}`);
    connectedUserId = userId;
    if (connection) {
      (connection as any)._closedCallbacks = [];
      await connection.stop();
      connection = null;
    }
  }

  if (connection) return connection;

  workerLog('connection:building');

  connection = new HubConnectionBuilder()
    .withUrl(`${env.NEXT_PUBLIC_SIGNALS_ENDPOINT}/hub`, {
      accessTokenFactory: () => token,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    })
    .configureLogging(LogLevel.Information)
    .withAutomaticReconnect([0, 2, 10, 18, 30, 45, 60, 90])
    .build();

  connection.onreconnected(() => {
    workerLog('connection:reconnected');
    setConnectionState({ state: 'connected' });
  });
  connection.onreconnecting((error) => {
    workerLog('connection:reconnecting', error?.message);
    setConnectionState({ state: 'reconnecting', message: JSON.stringify(error) });
  });
  connection.onclose((error) => {
    workerLog('connection:closed', error?.message);
    setConnectionState({ state: 'closed', message: JSON.stringify(error) });
  });
  connection.on('Pong', () => {
    lastServerPongAt = Date.now();
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
async function topicInvoke(method: string, topic: string) {
  try {
    if (!connection) {
      workerLog(`topic:${method}:no-connection`, topic);
      return;
    }
    await connection.invoke(method, topic);
    workerLog(`topic:${method}:ok`, topic);
  } catch (e) {
    workerLog(`topic:${method}:failed`, `${topic}: ${(e as Error).message}`);
  }
}

// --------------------------------
// Port management
// --------------------------------
const start = async (port: MessagePort) => {
  if (!port.postMessage) return;
  if (port.start) port.start();

  ports.set(port, { connectedAt: Date.now(), lastMessageAt: Date.now() });
  workerLog('port:connected', `total: ${ports.size}`);

  const postMessage = (req: WorkerOutgoingMessage) => port.postMessage(req);
  postMessage({ type: 'worker:ready' });
  postMessage({ type: 'connection:state', ...connectionState });

  const emitterOffHandlers = [
    emitter.on('stateChanged', ({ state, message }) =>
      postMessage({ type: 'connection:state', state, message })
    ),
    emitter.on('eventReceived', ({ target, payload }) =>
      postMessage({ type: 'event:received', target, payload })
    ),
    emitter.on('pong', () => postMessage({ type: 'pong' })),
    emitter.on('debugDump', (data) => postMessage({ type: 'debug:dump', data })),
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    const portMeta = ports.get(port);
    if (portMeta) portMeta.lastMessageAt = Date.now();

    if (data.type === 'connection:init') {
      workerLog('msg:connection:init', `userId: ${data.userId}`);
      await buildHubConnection({ token: data.token, userId: data.userId });
      await connect();
    } else if (data.type === 'event:register') {
      registerEvents([data.target]);
    } else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      ports.delete(port);
      workerLog('port:disconnected', `total: ${ports.size}`);
      port.close();
    } else if (data.type === 'ping') {
      emitter.emit('pong', undefined);
      broadcastCurrentConnectionState();
    } else if (data.type === 'topic:register') {
      await topicInvoke('subscribe', data.topic);
    } else if (data.type === 'topic:registerNotify') {
      await topicInvoke('subscribeNotify', data.topic);
    } else if (data.type === 'topic:unsubscribe') {
      await topicInvoke('unsubscribe', data.topic);
    } else if (data.type === 'send') {
      try {
        await connection?.send(data.target, data.args);
      } catch (e) {
        workerLog('send:failed', `${data.target}: ${(e as Error).message}`);
      }
    } else if (data.type === 'debug:dump') {
      emitter.emit('debugDump', getWorkerStatus());
    } else if (data.type === 'debug:toggle-verbose') {
      verboseLogging = !verboseLogging;
      workerLog('debug:verbose', `${verboseLogging}`);
    }
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
