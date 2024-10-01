import { useEffect, useMemo, useRef, useState } from 'react';
import SharedWorker from '@okikio/sharedworker';
import type { WorkerOutgoingMessage } from './types';
import { Deferred, EventEmitter } from './utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export type SignalStatus = 'connected' | 'closed' | 'error' | 'reconnected' | 'reconnecting';
export type SignalWorker = NonNullable<ReturnType<typeof useSignalsWorker>>;
type SignalState = {
  status: SignalStatus;
  message?: string;
};

const logs: Record<string, boolean> = {};

export function useSignalsWorker(
  args: { accessToken?: string },
  options?: {
    onConnected?: () => void;
    onReconnected?: () => void;
    onReconnecting?: () => void;
    /** A closed connection will not recover on its own. */
    onClosed?: (message?: string) => void;
    onError?: (message?: string) => void;
    onStatusChange?: (args: SignalState) => void;
  }
) {
  const currentUser = useCurrentUser();
  const { accessToken } = args;
  const { onConnected, onClosed, onError, onReconnected, onReconnecting, onStatusChange } =
    options ?? {};

  const [state, setState] = useState<SignalState>();
  const [ready, setReady] = useState(false);
  const [worker, setWorker] = useState<SharedWorker | null>(null);

  const emitterRef = useRef(new EventEmitter());
  const deferredRef = useRef(new Deferred());

  // handle init worker
  useEffect(() => {
    if (worker) return;
    setReady(false);
    setWorker(
      new SharedWorker(new URL('./worker.v1.2.ts', import.meta.url), {
        name: 'civitai-signals:1.2.5',
        type: 'module',
      })
    );
  }, [worker]);

  // handle register worker events
  useEffect(() => {
    if (!worker) return;

    worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
      if (data.type === 'worker:ready') setReady(true);
      else if (data.type === 'connection:ready')
        setState((prev) => {
          if (
            prev?.status === 'closed' ||
            prev?.status === 'error' ||
            prev?.status === 'reconnecting'
          )
            return { status: 'reconnected' };
          else return { status: 'connected' };
        });
      else if (data.type === 'connection:closed')
        setState({ status: 'closed', message: data.message });
      else if (data.type === 'connection:error')
        setState({ status: 'error', message: data.message });
      else if (data.type === 'connection:reconnected') setState({ status: 'reconnected' });
      else if (data.type === 'connection:reconnecting') setState({ status: 'reconnecting' });
      else if (data.type === 'event:received') emitterRef.current.emit(data.target, data.payload);
      else if (data.type === 'pong') deferredRef.current.resolve();
    };
  }, [worker]);

  useEffect(() => {
    if (!state) return;
    console.debug(`SignalService :: ${state.status}`);
    onStatusChange?.(state);
    switch (state.status) {
      case 'connected':
        return onConnected?.();
      case 'reconnected':
        return onReconnected?.();
      case 'reconnecting':
        return onReconnecting?.();
      case 'closed':
        return onClosed?.(state.message);
      case 'error':
        return onError?.(state.message);
    }
  }, [state]);

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
  }, []);

  // init
  useEffect(() => {
    if (worker && ready && accessToken && currentUser?.id)
      worker.port.postMessage({
        type: 'connection:init',
        token: accessToken,
        userId: currentUser.id,
      });
  }, [worker, accessToken, ready, currentUser?.id]);

  // ping
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
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
          setState({ status: 'closed', message: 'connection to shared worker lost' });
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

    return {
      on,
      off,
      send,
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
        window.logSignal('pong');
        worker?.port.postMessage({ type: 'ping' });
      };
    }
  }, [workerMethods]);

  const connected = state?.status === 'connected' || state?.status === 'reconnected';
  return connected ? workerMethods : null;
}
