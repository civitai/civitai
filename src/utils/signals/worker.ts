import { HttpTransportType, HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from './types';
import { Deferred, EventEmitter } from './utils';
import { env } from '~/env/client.mjs';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}
const _self: SharedWorkerGlobalScope = self as any;

let connection: HubConnection | undefined;
const events: Record<string, (data: unknown) => void> = {};
const deferred = new Deferred<void>();

const emitter = new EventEmitter<{
  connectionReady: undefined;
  connectionClosed: { message?: string };
  connectionError: { message?: string };
  eventReceived: { target: string; payload: any };
}>();

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
    connection.onreconnected(() => emitter.emit('connectionReady', undefined));
    connection.onclose((error) =>
      emitter.emit('connectionError', { message: JSON.stringify(error) })
    );
  } catch (e) {
    emitter.emit('connectionError', { message: JSON.stringify(e) });
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
  port.start();

  const postMessage = (req: WorkerOutgoingMessage) => port.postMessage(req);
  postMessage({ type: 'worker:ready' });

  const emitterOffHandlers = [
    emitter.on('connectionReady', () => postMessage({ type: 'connection:ready' })),
    emitter.on('connectionClosed', ({ message }) =>
      postMessage({ type: 'connection:closed', message })
    ),
    emitter.on('connectionError', ({ message }) =>
      postMessage({ type: 'connection:error', message })
    ),
    emitter.on('eventReceived', ({ target, payload }) =>
      postMessage({ type: 'event:received', target, payload })
    ),
  ];

  // incoming messages
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'connection:init')
      getConnection({ token: data.token }).then(() => {
        emitter.emit('connectionReady', undefined);
        deferred.resolve();
      });
    else if (data.type === 'event:register') registerEvents([data.target]);
    else if (data.type === 'beforeunload') {
      emitterOffHandlers.forEach((fn) => fn());
      port.close();
    }
  };
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback for WebWorkers, in case the browser doesn't support SharedWorkers natively
if (!('SharedWorkerGlobalScope' in _self)) start(_self as any);
