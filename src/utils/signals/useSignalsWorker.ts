import SharedWorker from '@okikio/sharedworker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDev } from '~/env/other';
import { trpc } from '~/utils/trpc';
import type {
  SignalConnectionState,
  SignalServerPingResult,
  SignalStatus,
  SignalTopicStatus,
  SignalWorkerStatus,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from './types';
import { PORT_HEARTBEAT_INTERVAL_MS, SIGNALS_WORKER_VERSION } from './types';
import {
  getBackoffDelay,
  HUB_STABLE_CONNECTION_MS,
  TOKEN_FETCH_RETRY_BACKOFF,
  TOKEN_REFRESH_BACKOFF,
  TOKEN_REVALIDATE_BACKOFF,
} from './backoff';
import { EventEmitter, teardownSignalWorker } from './utils';

const WORKER_PING_TIMEOUT_MS = 3000;
const STALE_SCRIPT_MAX_RETRIES = 3;
const STALE_SCRIPT_RETRY_DELAY_MS = 60_000;
// The token re-mint below already retries for as long as the hub stays unreachable, so the query's
// own retries only cover a one-off blip. Every retry is a `signals.getToken` against an API that, in
// an outage, is often the thing already saturated.
const TOKEN_FETCH_MAX_RETRIES = 2;

function getTokenFetchRetryDelay(failureCount: number) {
  return getBackoffDelay(failureCount, TOKEN_FETCH_RETRY_BACKOFF);
}

export type TopicStatusEvent = Omit<SignalTopicStatus, 'type'>;
export type TopicStatusHandler = (event: TopicStatusEvent) => void;
export type AnySignalHandler = (event: { target: string; payload: unknown }) => void;

// Internal emitter channels; the `__` prefix keeps them clear of hub message targets.
const TOPIC_STATUS_EVENT = '__topicStatus';
const ANY_SIGNAL_EVENT = '__anySignal';
const PONG_EVENT = '__pong';
const DUMP_EVENT = '__debugDump';
const SERVER_PONG_EVENT = '__serverPong';
const PORT_RESET_EVENT = '__portReset';

export type SignalWorker = NonNullable<ReturnType<typeof useSignalsWorker>>;

export type SignalsWorkerDebugState = {
  userId: number | undefined;
  ready: boolean;
  connection: SignalStatus | undefined;
  tokenStatus: 'pending' | 'error' | 'success';
  tokenError: string | undefined;
  hasToken: boolean;
  reconnectCount: number;
  /** As reported by the worker script; `'unknown'` for scripts older than 2.2. */
  workerVersion: string | undefined;
  staleScriptRetry: number;
};

export function useSignalsWorker(options?: {
  onStateChange?: (args: SignalConnectionState) => void;
}) {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id;
  const { onStateChange } = options ?? {};

  const [connection, setConnection] = useState<SignalStatus>();
  const [ready, setReady] = useState(false);
  const [worker, setWorker] = useState<SharedWorker | null>(null);
  const [workerGeneration, setWorkerGeneration] = useState(0);
  const [workerVersion, setWorkerVersion] = useState<string>();
  const [staleScriptRetry, setStaleScriptRetry] = useState(0);
  const staleScriptTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [reconnectCount, setReconnectCount] = useState(0);
  const shouldInitialize = connection === 'closed';

  const queryUtils = trpc.useUtils();
  const tokenQuery = trpc.signals.getToken.useQuery(undefined, {
    enabled: !!userId && shouldInitialize,
    retry: isDev ? false : TOKEN_FETCH_MAX_RETRIES,
    // React Query's default delay is deterministic, so every tab that failed together retried together.
    retryDelay: getTokenFetchRetryDelay,
  });
  const accessToken = tokenQuery.data?.accessToken;
  // Re-mints since the hub last accepted a connection; picks the next step of the backoff below.
  const tokenRefreshAttemptRef = useRef(0);
  // The last real token this tab was given, for this user. A re-mint that comes back degraded (`{}`)
  // must not take the tab's token away: the token never expires, so the tab keeps handing this one to
  // the worker — on every 'closed', and to a replacement worker — and stays on the slow re-mint
  // schedule rather than the no-token one.
  const lastTokenRef = useRef<{ token: string; fetchedAt: number; userId: number }>();
  if (accessToken && userId)
    lastTokenRef.current = { token: accessToken, fetchedAt: tokenQuery.dataUpdatedAt, userId };
  const workerToken = lastTokenRef.current?.userId === userId ? lastTokenRef.current : undefined;

  const emitterRef = useRef(new EventEmitter());
  const debugStateRef = useRef<SignalsWorkerDebugState>();
  debugStateRef.current = {
    userId,
    ready,
    connection,
    tokenStatus: tokenQuery.status,
    tokenError: tokenQuery.error?.message,
    hasToken: !!accessToken,
    reconnectCount,
    workerVersion,
    staleScriptRetry,
  };

  // handle init worker
  useEffect(() => {
    const emitter = emitterRef.current;
    // A SharedWorker is matched by name and URL together, so a retry changes both.
    const retrySuffix = staleScriptRetry ? `-r${staleScriptRetry}` : '';
    // Built by `pnpm build:workers` (scripts/build-workers.mjs) → public/workers.
    // Static path (not new URL(import.meta.url)) to bypass Turbopack's broken
    // .ts SharedWorker compilation — see vercel/next.js#74842.
    const newWorker = new SharedWorker(
      `/workers/signals.worker.js?v=${SIGNALS_WORKER_VERSION}${retrySuffix}`,
      { name: `civitai-signals:${SIGNALS_WORKER_VERSION}${retrySuffix}` }
    );
    setReady(false);
    setWorkerVersion(undefined);
    setWorker(newWorker);

    function cleanup() {
      // `teardownSignalWorker` sends `beforeunload` then uses the wrapper's
      // polymorphic close() — closing the MessagePort on SharedWorker-capable
      // browsers and terminating the dedicated Worker on the fallback path
      // (Android Chrome / Samsung Internet). Calling `newWorker.port.close()`
      // directly threw `TypeError: port.close is not a function` on the fallback
      // cohort, where `port` is the Worker (no `.close()`).
      teardownSignalWorker(newWorker);
      emitter.stop();
    }

    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      clearTimeout(staleScriptTimerRef.current);
      cleanup();
      setWorker(null);
    };
  }, [workerGeneration, staleScriptRetry]);

  // A tab can load a worker script from before or after its own deploy (old CDN copy, rolling pod).
  // Retry with a fresh URL a few times rather than run against a protocol the tab doesn't speak.
  useEffect(() => {
    if (!workerVersion || workerVersion === SIGNALS_WORKER_VERSION) return;
    if (staleScriptRetry >= STALE_SCRIPT_MAX_RETRIES) return;
    staleScriptTimerRef.current = setTimeout(
      () => setStaleScriptRetry((r) => r + 1),
      STALE_SCRIPT_RETRY_DELAY_MS
    );
    return () => clearTimeout(staleScriptTimerRef.current);
  }, [workerVersion, staleScriptRetry]);

  useEffect(() => {
    if (!worker) return;
    const interval = setInterval(
      () => worker.port.postMessage({ type: 'port:heartbeat' }),
      PORT_HEARTBEAT_INTERVAL_MS
    );
    return () => clearInterval(interval);
  }, [worker]);

  // handle register worker events
  useEffect(() => {
    if (!worker) return;

    worker.port.onmessage = async ({ data }: { data: WorkerOutgoingMessage }) => {
      const emitter = emitterRef.current;
      if (data.type === 'worker:ready') {
        setReady(true);
        // Pre-2.2 scripts send no version.
        setWorkerVersion(data.version ?? 'unknown');
        if (data.version !== SIGNALS_WORKER_VERSION)
          console.warn(
            `[signals] Worker script is ${
              data.version ?? 'pre-2.2'
            }, tab expects ${SIGNALS_WORKER_VERSION}`
          );
      } else if (data.type === 'port:reset') emitter.emit(PORT_RESET_EVENT, undefined);
      else if (data.type === 'event:received') {
        emitter.emit(data.target, data.payload);
        emitter.emit(ANY_SIGNAL_EVENT, { target: data.target, payload: data.payload });
      } else if (data.type === 'pong') {
        setReady(true);
        emitter.emit(PONG_EVENT, undefined);
      } else if (data.type === 'topic:status') {
        const { type: _t, ...event } = data;
        emitter.emit(TOPIC_STATUS_EVENT, event);
      } else if (data.type === 'debug:dump') {
        emitter.emit(DUMP_EVENT, data.data);
      } else if (data.type === 'debug:server-pong') {
        const { type: _t, ...result } = data;
        emitter.emit(SERVER_PONG_EVENT, result);
      } else if (data.type === 'connection:state') {
        setConnection(data.state ?? 'closed');
        onStateChange?.({ state: data.state, message: data.message });
        // The token is NOT re-minted here: it carries no expiry, so the one this tab holds is retried
        // first, and the backed-off refresh below replaces it only if the hub keeps refusing.
        if (data.state === 'closed') setReconnectCount((c) => c + 1);
      }
    };
  }, [worker]);

  // While the connection stays closed, re-fetch the token on a jittered backoff. A tab that has
  // never held a token (the degraded `{}` response, or a failed fetch) never opens a connection and
  // gets no further 'closed', so this is the only way it recovers (it used to need a reload): ~5-30s
  // after the close, doubling to a 10 min ceiling. Once a tab has had a token, the worker keeps
  // retrying with it, so it is re-minted only as a slow safety net (TOKEN_REVALIDATE_BACKOFF) — even
  // if a re-mint comes back `{}`. Re-minting on
  // every 'closed' instead, in every tab at once, multiplied `signals.getToken` ~50x in one outage.
  // Each settled fetch re-arms the timer with the next step. Deliberately keyed on the query's own
  // state only — anything that re-rendered more often would keep pushing the timer back and the
  // refresh would never fire.
  const tokenIsFetching = tokenQuery.isFetching;
  const tokenInPlay = !!workerToken;
  useEffect(() => {
    if (connection === 'connected') {
      // Like the worker's own backoff, reset only once the connection has proved stable: a hub that
      // accepts and then drops connections must not restart the schedule every cycle.
      const timer = setTimeout(() => {
        tokenRefreshAttemptRef.current = 0;
      }, HUB_STABLE_CONNECTION_MS);
      return () => clearTimeout(timer);
    }
    if (!userId || connection !== 'closed' || tokenIsFetching) return;
    const config = tokenInPlay ? TOKEN_REVALIDATE_BACKOFF : TOKEN_REFRESH_BACKOFF;
    const timer = setTimeout(() => {
      tokenRefreshAttemptRef.current += 1;
      queryUtils.signals.getToken.invalidate();
    }, getBackoffDelay(tokenRefreshAttemptRef.current, config));
    return () => clearTimeout(timer);
  }, [
    userId,
    connection,
    tokenInPlay,
    tokenIsFetching,
    tokenQuery.dataUpdatedAt,
    tokenQuery.errorUpdatedAt,
  ]);

  // init
  const workerTokenValue = workerToken?.token;
  const workerTokenFetchedAt = workerToken?.fetchedAt;
  useEffect(() => {
    if (worker && ready && workerTokenValue && workerTokenFetchedAt !== undefined && userId)
      worker.port.postMessage({
        type: 'connection:init',
        token: workerTokenValue,
        userId,
        tokenFetchedAt: workerTokenFetchedAt,
      });
  }, [worker, workerTokenValue, workerTokenFetchedAt, ready, userId, reconnectCount]);

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

    function onTopicStatus(cb: TopicStatusHandler) {
      emitterRef.current.on(TOPIC_STATUS_EVENT, cb as (data: unknown) => void);
    }

    function offTopicStatus(cb: TopicStatusHandler) {
      emitterRef.current.off(TOPIC_STATUS_EVENT, cb as (data: unknown) => void);
    }

    /** Fires for every signal this tab receives, whatever its target. */
    function onAnySignal(cb: AnySignalHandler) {
      emitterRef.current.on(ANY_SIGNAL_EVENT, cb as (data: unknown) => void);
    }

    function offAnySignal(cb: AnySignalHandler) {
      emitterRef.current.off(ANY_SIGNAL_EVENT, cb as (data: unknown) => void);
    }

    /** Fires when the worker dropped this tab's topics as stale; re-register them. */
    function onPortReset(cb: () => void) {
      emitterRef.current.on(PORT_RESET_EVENT, cb);
    }

    function offPortReset(cb: () => void) {
      emitterRef.current.off(PORT_RESET_EVENT, cb);
    }

    /** Resolves with the worker's reply, or `null` if none arrives within `timeoutMs`. */
    function request<T>(message: WorkerIncomingMessage, replyEvent: string, timeoutMs: number) {
      return new Promise<T | null>((resolve) => {
        if (!worker) return resolve(null);
        const emitter = emitterRef.current;
        const onReply = (data: unknown) => {
          clearTimeout(timer);
          emitter.off(replyEvent, onReply);
          resolve(data as T);
        };
        const timer = setTimeout(() => {
          emitter.off(replyEvent, onReply);
          resolve(null);
        }, timeoutMs);
        emitter.on(replyEvent, onReply);
        worker.port.postMessage(message);
      });
    }

    const debug = {
      getState: () => debugStateRef.current!,
      getWorkerStatus: (timeoutMs = 2000) =>
        request<SignalWorkerStatus>({ type: 'debug:dump' }, DUMP_EVENT, timeoutMs),
      /** Round-trip to the worker in ms, or `null` if it didn't answer. */
      pingWorker: async (timeoutMs = 2000) => {
        const startedAt = performance.now();
        const reply = await request<undefined>({ type: 'ping' }, PONG_EVENT, timeoutMs);
        return reply === null ? null : Math.round(performance.now() - startedAt);
      },
      /** Round-trip through the WebSocket to the signals server; `null` if the worker didn't answer. */
      pingServer: (timeoutMs = 8000) =>
        request<SignalServerPingResult>(
          { type: 'debug:server-ping' },
          SERVER_PONG_EVENT,
          timeoutMs
        ),
      /**
       * Skips every backoff: an immediate hub attempt with the token the tab holds, while a fresh
       * token is fetched in parallel and used from the next attempt on.
       */
      forceReconnect: () => {
        tokenRefreshAttemptRef.current = 0;
        // The query is disabled while connected; invalidating marks it stale, so it refetches the
        // moment the worker reports 'closed'.
        queryUtils.signals.getToken.invalidate();
        worker?.port.postMessage({ type: 'debug:reconnect' });
      },
      toggleVerbose: () => worker?.port.postMessage({ type: 'debug:toggle-verbose' }),
      getSubscriberCounts: () =>
        Object.fromEntries(
          Object.entries(emitterRef.current.callbacks as Record<string, unknown[]>)
            .filter(([target]) => !target.startsWith('__'))
            .map(([target, list]) => [target, list?.length ?? 0])
        ),
    };

    return {
      on,
      off,
      send,
      topicRegister,
      topicUnsubscribe,
      onTopicStatus,
      offTopicStatus,
      onAnySignal,
      offAnySignal,
      onPortReset,
      offPortReset,
      debug,
    };
  }, [worker]);

  // A tab waking from sleep can hold a port to a worker the browser has since reaped, which never
  // answers. A slow worker's late pong still marks it ready; a silent one is replaced.
  useEffect(() => {
    if (!worker) return;
    // Only a SharedWorker can be reaped apart from the tab; replacing the dedicated-Worker fallback
    // would just drop a working connection.
    if (typeof window.SharedWorker === 'undefined') return;
    // A ping outliving this worker must not replace its successor.
    let cancelled = false;
    async function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const { pingWorker } = workerMethods.debug;
      // A waking tab's main thread can stall past one timeout, so a miss must repeat.
      if ((await pingWorker(WORKER_PING_TIMEOUT_MS)) !== null) return;
      if (cancelled || (await pingWorker(WORKER_PING_TIMEOUT_MS)) !== null) return;
      if (!cancelled) setWorkerGeneration((g) => g + 1);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [worker, workerMethods]);

  return workerMethods;
}
