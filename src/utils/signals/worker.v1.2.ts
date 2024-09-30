import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  // HubConnectionState,
} from '@microsoft/signalr';
import { env } from '~/env/client.mjs';
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from './types';
import { EventEmitter } from './utils';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}

const _self: SharedWorkerGlobalScope = self as any;

let connection: HubConnection | null = null;
// let pingInterval: NodeJS.Timer | null = null;
const events: Record<string, (data: unknown) => void> = {};

const emitter = new EventEmitter<{
  connectionReady: undefined;
  connectionClosed: { message?: string };
  connectionError: { message?: string };
  connectionReconnecting: { message?: string };
  connectionReconnected: undefined;
  eventReceived: { target: string; payload: any };
  pong: undefined;
}>();

async function connect(args?: { retryAttempts?: number; timeout?: number }) {
  const { retryAttempts = 10, timeout = 5000 } = args ?? {};
  try {
    if (!connection) return;
    await connection.start();
    emitter.emit('connectionReady', undefined);
    console.log('SignalR Connected.');
  } catch (err) {
    console.log(err);
    setTimeout(() => {
      if (retryAttempts > 0) connect({ retryAttempts: retryAttempts - 1, timeout: timeout * 1.2 });
      else {
        emitter.emit('connectionError', { message: 'failed to connect to signal service' });
        connection = null;
      }
    }, timeout);
  }
}

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
    connection.onreconnected(() => {
      emitter.emit('connectionReconnected', undefined);
    });
    connection.onreconnecting((error) => {
      emitter.emit('connectionReconnecting', { message: JSON.stringify(error) });
    });
    connection.onclose((error) => {
      emitter.emit('connectionClosed', { message: JSON.stringify(error) });
      connect();
    });
    connection.on('Pong', () => {
      console.log('pong');
    });

    for (const [target, event] of Object.entries(events)) {
      connection.on(target, event);
    }

    await connect();
  } catch (error) {
    console.log(error);
    emitter.emit('connectionError', { message: (error as Error).message ?? '' });
    try {
      await connection.stop();
    } catch (e) {}
    connection = null;
  }

  return connection;
};

const registerEvents = async (targets: string[]) => {
  for (const target of targets) {
    if (!events[target]) {
      events[target] = (payload) => emitter.emit('eventReceived', { target, payload });
      if (connection) {
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
    emitter.on('pong', () => {
      postMessage({ type: 'pong' });
      postMessage({ type: 'event:received', target: 'pong', payload: connection?.state });
    }),
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'connection:init') getConnection({ token: data.token });
    else if (data.type === 'event:register') registerEvents([data.target]);
    else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      port.close();
    } else if (data.type === 'ping') emitter.emit('pong', undefined);
    else if (data.type === 'send') connection?.send(data.target, data.args);
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
