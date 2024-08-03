import { Deferred, EventEmitter } from './utils';
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from './types';
import SharedWorker from '@okikio/sharedworker';
import { createStore } from 'zustand/vanilla';

// Debugging
const logs: Record<string, boolean> = {};

type State = { available: boolean };
type Store = State & { update: (fn: (args: State) => State) => void };

export type SignalWorker = ReturnType<typeof createSignalWorker>;
export const createSignalWorker = ({
  onConnected,
  onClosed,
  onError,
  onReconnected,
  onReconnecting,
}: {
  onConnected?: () => void;
  onReconnected?: () => void;
  onReconnecting?: () => void;
  /** A closed connection will not recover on its own. */
  onClosed?: (message?: string) => void;
  onError?: (message?: string) => void;
}) => {
  const deferred = new Deferred();
  const emitter = new EventEmitter();
  const events: Record<string, boolean> = {};
  let pingDeferred: Deferred | undefined;

  const { getState, subscribe } = createStore<Store>((set) => ({
    available: false,
    signal: 'closed',
    update: (fn) => set((args) => ({ ...fn(args) })),
  }));

  const worker = new SharedWorker(new URL('./worker.v1.2.ts', import.meta.url), {
    name: 'civitai-signals:1.2',
    type: 'module',
  });

  worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
    if (data.type === 'worker:ready') deferred.resolve();
    else if (data.type === 'connection:ready') onConnected?.();
    else if (data.type === 'connection:closed') onClosed?.(data.message);
    else if (data.type === 'connection:error') onError?.(data.message);
    else if (data.type === 'connection:reconnected') onReconnected?.();
    else if (data.type === 'connection:reconnecting') onReconnecting?.();
    else if (data.type === 'event:received') emitter.emit(data.target, data.payload);
    else if (data.type === 'pong') pingDeferred?.resolve();
  };

  const postMessage = (message: WorkerIncomingMessage) => worker.port.postMessage(message);

  const on = (target: string, cb: (data: unknown) => void) => {
    if (!events[target]) {
      events.target = true;
      postMessage({ type: 'event:register', target });
    }
    emitter.on(target, cb);
  };

  const off = (target: string, cb: (data: unknown) => void) => {
    emitter.off(target, cb);
  };

  const unload = () => {
    postMessage({ type: 'beforeunload' });
    emitter.stop();
  };

  const ping = async () => {
    if (!pingDeferred && document.visibilityState === 'visible') {
      pingDeferred = new Deferred();
      postMessage({ type: 'ping' });
      setTimeout(() => {
        if (pingDeferred) pingDeferred.reject();
      }, 1000);

      await pingDeferred.promise
        .then(() => getState().update((state) => ({ ...state, available: true })))
        .catch(() => {
          getState().update((state) => ({ ...state, available: false }));
          onClosed?.('connection to shared worker lost');
        });
      pingDeferred = undefined;
    }
  };

  if (typeof window !== 'undefined') {
    window.logSignal = (target, selector) => {
      function logFn(args: unknown) {
        if (selector) {
          const result = [args].find(selector);
          if (result) console.log(result);
        } else console.log(args);
      }
      if (!logs[target]) {
        logs[target] = true;
        on(target, logFn);
        console.log(`begin logging: ${target}`);
      } else {
        delete logs[target];
        off(target, logFn);
        console.log(`end logging: ${target}`);
      }
    };
  }

  const close = () => {
    document.removeEventListener('visibilitychange', ping);
    window.removeEventListener('beforeunload', unload);
    unload();
  };

  // fire off an event to remove this port from the worker
  window.addEventListener('beforeunload', unload, { once: true });
  // ping-pong with worker to check for worker availability
  document.addEventListener('visibilitychange', ping);

  async function init(token: string) {
    await deferred.promise;
    postMessage({ type: 'connection:init', token });
  }

  return {
    on,
    off,
    close,
    subscribe,
    init,
  };
};
