import { Deferred, EventEmitter } from './utils';
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from './types';
import SharedWorker from '@okikio/sharedworker';

export type SignalWorker = AsyncReturnType<typeof createSignalWorker>;
export const createSignalWorker = async ({
  token,
  onConnected,
  onClosed,
  onError,
}: {
  token: string;
  onConnected?: () => void;
  onClosed?: (message?: string) => void;
  onError?: (message?: string) => void;
}) => {
  const deferred = new Deferred<void>();
  const emitter = new EventEmitter();
  const events: Record<string, boolean> = {};

  const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), {
    name: 'civitai-signals',
    type: 'module',
  });

  worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
    if (data.type === 'worker:ready') deferred.resolve();
    else if (data.type === 'connection:ready') onConnected?.();
    else if (data.type === 'connection:closed') onClosed?.(data.message);
    else if (data.type === 'connection:error') onError?.(data.message);
    else if (data.type === 'event:received') emitter.emit(data.target, data.payload);
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

  await deferred.promise;

  // fire off an event to remove this port from the worker
  window.addEventListener('beforeunload', () => unload(), {
    once: true,
  });

  postMessage({ type: 'connection:init', token });

  return {
    on,
    off,
    unload,
  };
};
