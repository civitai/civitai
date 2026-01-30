import SharedWorker from '@okikio/sharedworker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import type { SignalConnectionState, SignalStatus, WorkerOutgoingMessage } from './types';
import { Deferred, EventEmitter } from './utils';

export type SignalWorker = NonNullable<ReturnType<typeof useSignalsWorker>>;

const logs: Record<string, boolean> = {};
let logConnectionState = false;

export function useSignalsWorker(options?: {
  onStateChange?: (args: SignalConnectionState) => void;
}) {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id;
  const { onStateChange } = options ?? {};

  const [connection, setConnection] = useState<SignalStatus>();
  const [ready, setReady] = useState(false);
  const [worker, setWorker] = useState<SharedWorker | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  const shouldInitialize = connection === 'closed';

  const queryUtils = trpc.useUtils();
  const { data } = trpc.signals.getToken.useQuery(undefined, {
    enabled: !!userId && shouldInitialize,
  });
  const accessToken = data?.accessToken;

  const emitterRef = useRef(new EventEmitter());
  const deferredRef = useRef(new Deferred());

  // handle init worker
  useEffect(() => {
    if (worker) return;
    setReady(false);
    setWorker(
      (worker) =>
        worker ??
        new SharedWorker(new URL('./worker.ts', import.meta.url), {
          name: 'civitai-signals:2',
          type: 'module',
        })
    );
  }, [worker]);

  // handle register worker events
  useEffect(() => {
    if (!worker) return;

    worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
      if (data.type === 'worker:ready') setReady(true);
      else if (data.type === 'event:received') emitterRef.current.emit(data.target, data.payload);
      else if (data.type === 'pong') deferredRef.current.resolve();
      else if (data.type === 'connection:state') {
        setConnection(data.state ?? 'closed');
        onStateChange?.({ state: data.state, message: data.message });
        if (data.state === 'closed') {
          queryUtils.signals.getToken.invalidate();
          setReconnectCount((c) => c + 1);
        }
        if (logConnectionState) console.log({ state: data.state }, new Date().toLocaleTimeString());
      }
    };
  }, [worker]);

  // handle tab close
  useEffect(() => {
    function unload() {
      worker?.port.postMessage({ type: 'beforeunload' });
      emitterRef.current.stop();
    }

    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('beforeunload', unload);
    };
  }, [worker]);

  // init
  useEffect(() => {
    if (worker && ready && accessToken && userId)
      worker.port.postMessage({
        type: 'connection:init',
        token: accessToken,
        userId,
      });
  }, [worker, accessToken, ready, userId, reconnectCount]);

  // ping
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible' || !worker) return;
      deferredRef.current = new Deferred();
      worker?.port.postMessage({ type: 'ping' });
      const timeout = setTimeout(() => deferredRef.current.reject(), 1000);
      deferredRef.current.promise
        .then(() => {
          clearTimeout(timeout);
          setReady(true);
        })
        .catch(() => {
          setReady(false);
          setConnection('closed');
        });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [worker]);

  const workerMethods = useMemo(() => {
    function send(target: string, args: Record<string, unknown>) {
      worker?.port.postMessage({ type: 'send', target, args });
    }

    function on(target: string, cb: (data: unknown) => void) {
      worker?.port.postMessage({ type: 'event:register', target });
      emitterRef.current.on(target, cb);
    }

    function off(target: string, cb: (data: unknown) => void) {
      emitterRef.current.off(target, cb);
    }

    function topicRegister(topic: string, notify?: boolean) {
      worker?.port.postMessage({ type: notify ? 'topic:registerNotify' : 'topic:register', topic });
    }

    function topicUnsubscribe(topic: string) {
      worker?.port.postMessage({ type: 'topic:unsubscribe', topic });
    }

    return {
      on,
      off,
      send,
      topicRegister,
      topicUnsubscribe,
    };
  }, [worker]);

  useEffect(() => {
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
          workerMethods.on(target, logFn);
          console.log(`begin logging: ${target}`);
        }
      };

      window.ping = () => {
        worker?.port.postMessage({ type: 'ping' });
        logConnectionState = true;
      };
    }
  }, [workerMethods]);

  // const connected = state?.status === 'connected' || state?.status === 'reconnected';
  // console.log({ connected, status: state?.status });
  return workerMethods;
}
