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
  SignalStatus,
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

let connectionState: SignalConnectionState = { state: null };
let connectedUserId: number | null = null;
let connection: HubConnection | null = null;
// let pingInterval: NodeJS.Timer | null = null;
const events: Record<string, (data: unknown) => void> = {};

const emitter = new EventEmitter<{
  eventReceived: { target: string; payload: any };
  stateChanged: SignalConnectionState;
  pong: undefined;
}>();

function setConnectionState(args: { state: SignalStatus; message?: string }) {
  emitter.emit('stateChanged', args);
}

function emitCurrentConnectionState() {
  emitter.emit('stateChanged', connectionState);
}

emitter.on('stateChanged', ({ state, message, ...args }) => {
  connectionState = { state, message };
  if (state === 'closed') connection = null;
  console.log(`SignalR status: ${state}`, message, args);
});

// let interval: NodeJS.Timer | undefined;
// if (interval) clearInterval(interval);
// interval = setInterval(emitCurrentConnectionState, 10 * 1000);

async function connect() {
  try {
    if (!connection) throw new Error('missing SignalR connection');
    // don't try to connect unless the connection is closed
    if (connection.state !== HubConnectionState.Disconnected) return;
    try {
      await connection.start();
      setConnectionState({ state: 'connected' });
    } catch (err) {
      console.log(err);
      setTimeout(() => connect(), 5000);
    }
  } catch (e) {
    setConnectionState({ state: 'closed', message: (e as Error).message });
  }
}

const buildHubConnection = async ({ userId, token }: { token: string; userId: number }) => {
  if (userId !== connectedUserId) {
    connectedUserId = userId;
    if (connection) {
      (connection as any)._closedCallbacks = [];
      await connection.stop();
      connection = null;
    }
  }

  if (connection) return connection;

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
    setConnectionState({ state: 'connected' });
  });
  connection.onreconnecting((error) => {
    setConnectionState({ state: 'reconnecting', message: JSON.stringify(error) });
  });
  connection.onclose((error) => {
    setConnectionState({ state: 'closed', message: JSON.stringify(error) });
  });
  connection.on('Pong', () => console.log('pong'));

  for (const [target, event] of Object.entries(events)) {
    connection.on(target, event);
  }
  return connection;
};

async function registerEvents(targets: string[]) {
  for (const target of targets) {
    if (!events[target]) {
      events[target] = (payload) => emitter.emit('eventReceived', { target, payload });
      if (connection) {
        connection.on(target, events[target]);
      }
    }
  }
}

const start = async (port: MessagePort) => {
  if (!port.postMessage) return;
  if (port.start) port.start();

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
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'connection:init') {
      await buildHubConnection({ token: data.token, userId: data.userId });
      await connect();
    } else if (data.type === 'event:register') registerEvents([data.target]);
    else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      port.close();
    } else if (data.type === 'ping') {
      emitter.emit('pong', undefined);
      emitCurrentConnectionState();
    } else if (data.type === 'topic:register') {
      await connection?.invoke('subscribe', data.topic);
    } else if (data.type === 'topic:registerNotify') {
      await connection?.invoke('subscribeNotify', data.topic);
    } else if (data.type === 'topic:unsubscribe') {
      await connection?.invoke('unsubscribe', data.topic);
    } else if (data.type === 'send') connection?.send(data.target, data.args);
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
