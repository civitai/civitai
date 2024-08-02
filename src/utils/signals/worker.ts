import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
} from '@microsoft/signalr';
import { env } from '~/env/client.mjs';
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from './types';
import { Deferred, EventEmitter } from './utils';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}

const _self: SharedWorkerGlobalScope = self as any;

let connection: HubConnection | null = null;
let pingInterval: NodeJS.Timer | null = null;
const events: Record<string, (data: unknown) => void> = {};
const deferred = new Deferred<void>();

const emitter = new EventEmitter<{
  connectionReady: undefined;
  connectionClosed: { message?: string };
  connectionError: { message?: string };
  connectionReconnecting: { message?: string };
  connectionReconnected: undefined;
  eventReceived: { target: string; payload: any };
  pong: undefined;
}>();

let pingTimeout: NodeJS.Timeout | null = null;
const PING_TIMEOUT = 5000;
const PING_INTERVAL = 15 * 1000;
const getConnection = async ({ token }: { token: string }) => {
  if (connection) return connection;

  connection = new HubConnectionBuilder()
    .withUrl(`${env.NEXT_PUBLIC_SIGNALS_ENDPOINT}/hub`, {
      accessTokenFactory: () => token,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
    })
    .withAutomaticReconnect()
    .build();

  try {
    await connection.start();
    connection.onreconnected(() => {
      emitter.emit('connectionReady', undefined);
      emitter.emit('connectionReconnected', undefined);
    });
    connection.onreconnecting((error) => {
      emitter.emit('connectionReconnecting', { message: JSON.stringify(error) });
    });
    connection.onclose((error) => {
      emitter.emit('connectionClosed', { message: JSON.stringify(error) });
      connection = null;
      if (pingInterval) clearInterval(pingInterval);
    });

    // Handle cases where signalr is in an odd state
    pingInterval = setInterval(async () => {
      if (!connection || connection.state !== HubConnectionState.Connected) {
        if (pingInterval) clearInterval(pingInterval);
        return;
      }
      await connection.send('ping');
      pingTimeout = setTimeout(async () => {
        console.log('timed out');
        if (!connection) return;
        await connection.stop();
        connection = null;
        emitter.emit('connectionError', { message: 'ping timeout' });
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
    // Backend response with `Pong` to the `ping`
    connection.on('Pong', () => {
      console.log('pong');
      if (pingTimeout) clearTimeout(pingTimeout);
    });
  } catch (e) {
    emitter.emit('connectionError', { message: JSON.stringify(e) });
    connection = null;
  }

  return connection;
};

const registerEvents = async (targets: string[]) => {
  await deferred.promise;
  if (!connection) emitter.emit('connectionError', { message: 'unable to establish a connection' });
  else {
    for (const target of targets) {
      if (!events[target]) {
        events[target] = (payload) => emitter.emit('eventReceived', { target, payload });
        connection.on(target, events[target]);
      }
    }
  }
};

const start = async (port: MessagePort) => {
  if (!port.postMessage) return;
  if (port.start) port.start();

  const postMessage = (req: WorkerOutgoingMessage) => port.postMessage(req);
  postMessage({ type: 'worker:ready' });

  const emitterOffHandlers = [
    emitter.on('connectionReconnected', () => postMessage({ type: 'connection:reconnected' })),
    emitter.on('connectionReady', () => postMessage({ type: 'connection:ready' })),
    emitter.on('connectionClosed', ({ message }) =>
      postMessage({ type: 'connection:closed', message })
    ),
    emitter.on('connectionError', ({ message }) =>
      postMessage({ type: 'connection:error', message })
    ),
    emitter.on('connectionReconnecting', ({ message }) =>
      postMessage({ type: 'connection:reconnecting', message })
    ),
    emitter.on('eventReceived', ({ target, payload }) =>
      postMessage({ type: 'event:received', target, payload })
    ),
    emitter.on('pong', () => postMessage({ type: 'pong' })),
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'connection:init')
      getConnection({ token: data.token }).then((connection) => {
        if (!connection) return;
        emitter.emit('connectionReady', undefined);
        deferred.resolve();
      });
    else if (data.type === 'event:register') registerEvents([data.target]);
    else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      port.close();
    } else if (data.type === 'ping') emitter.emit('pong', undefined);
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
