import type { MantineColor, NotificationProps } from '@mantine/core';
import { Notification } from '@mantine/core';
import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { SignalMessages } from '~/server/common/enums';
import type { SignalTopic } from '~/server/common/enums';
import { useDebouncer } from '~/utils/debouncer';
import { getRandomInt } from '~/utils/number-helpers';
import type { SignalStatus } from '~/utils/signals/types';
// import { createSignalWorker, SignalWorker } from '~/utils/signals';
import type { SignalWorker, TopicStatusHandler } from '~/utils/signals/useSignalsWorker';
import { useSignalsWorker } from '~/utils/signals/useSignalsWorker';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import { trpc } from '~/utils/trpc';

type TopicString = `${SignalTopic}${'' | `:${number | string}`}`;

type MetricSignalsStoreState = ReturnType<typeof useMetricSignalsStore.getState>;

type RetryState = {
  timerId: ReturnType<typeof setTimeout>;
  attempts: number;
};

declare global {
  interface Window {
    __signals?: {
      /** Current topic → refcount map. */
      getTopicRefs: () => Record<string, number>;
      /** Topics with a retry scheduled after a failed subscribe. */
      getPendingRetries: () => Record<string, { attempts: number }>;
      /**
       * Last time each topic was acknowledged as subscribed by the hub (a
       * `topic:status` with `ok: true` for `subscribe` / `subscribeNotify`).
       * Useful for detecting silent eviction: if a topic's confirmation is
       * hours old and the user reports no updates, the hub may have dropped
       * the subscription without telling us.
       */
      getLastConfirmed: () => Record<string, { ageMs: number; at: string }>;
      /** Deltas currently accumulated in the metric-signals store. */
      getDeltas: () => Record<string, number>;
      /** Simulates a push from the hub — applies a delta directly to the store. */
      emitMetric: MetricSignalsStoreState['applyDelta'];
      /** Clears accumulated deltas for an entity (or a single metric). */
      clearDeltas: MetricSignalsStoreState['clearDelta'];
    };
  }
}

type SignalState = {
  connected: boolean;
  status: SignalStatus | null;
  worker: SignalWorker | null;
  registeredTopics: string[];
  setRegisteredTopics: Dispatch<SetStateAction<string[]>>;
  /**
   * Increments the refcount for `topic` and registers with the worker on the
   * first subscriber. Safe to call multiple times for the same topic from
   * different components — only the last `releaseTopic` actually unsubscribes.
   */
  registerTopic: (topic: TopicString, notify?: boolean) => void;
  /**
   * Decrements the refcount for `topic`. Unsubscribes from the worker only
   * when the refcount hits zero.
   */
  releaseTopic: (topic: TopicString) => void;
};

const signalStatusDictionary: Record<SignalStatus, MantineColor> = {
  connected: 'green',
  reconnecting: 'yellow',
  closed: 'red',
};

// Retry policy for failed `subscribe`/`subscribeNotify` calls. Only kicks in
// for hub-side failures while the connection was up — `no-connection` cases
// are handled by the reconnect effect, not by retries.
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;

const SignalContext = createContext<SignalState | null>(null);
export const useSignalContext = () => {
  const context = useContext(SignalContext);
  if (!context) throw new Error('SignalContext not in tree');
  return context;
};

// Add possible types to this data structure. Leave any for safeguarding.
type SignalCallback = (data: any) => void;

export const useSignalConnection = (message: SignalMessages, cb: SignalCallback) => {
  const { worker } = useSignalContext();
  const cbRef = useRef(cb);
  // any updates to cb will be assigned to cbRef.current
  cbRef.current = cb;

  useEffect(() => {
    const callback = (args: any) => cbRef.current(args);

    worker?.on(message, callback);
    return () => {
      worker?.off(message, callback);
    };
  }, [worker, message]);
};

export const useSignalTopic = (topic: TopicString | undefined, notify?: boolean) => {
  const { registerTopic, releaseTopic } = useSignalContext();

  useEffect(() => {
    if (!topic) return;
    registerTopic(topic, notify);
    return () => releaseTopic(topic);
  }, [topic, notify, registerTopic, releaseTopic]);
};

const SIGNAL_DATA_REFRESH_DEBOUNCE = 10;
export function SignalProvider({ children }: { children: React.ReactNode }) {
  const queryUtils = trpc.useUtils();
  const prevStatusRef = useRef<SignalStatus | null>(null);
  const hasConnectedAtLeastOnceRef = useRef(false);
  const debounce = useDebouncer((SIGNAL_DATA_REFRESH_DEBOUNCE + getRandomInt(-2, 5)) * 1000);

  const [status, setStatus] = useState<SignalStatus | null>(null);
  prevStatusRef.current = status ?? null;
  const [registeredTopics, setRegisteredTopics] = useState<string[]>([]);
  // Refcount of active `useSignalTopic` subscribers per topic. Only the
  // 0→1 transition calls `worker.topicRegister`; only the 1→0 transition
  // unsubscribes — so duplicate subscribers don't cause one another to lose
  // updates on unmount.
  const topicRefs = useRef<Map<string, number>>();
  if (!topicRefs.current) topicRefs.current = new Map();
  // Last-seen `notify` flag per topic, used when the reconnect effect and
  // retry scheduler re-register.
  const topicNotify = useRef<Map<string, boolean | undefined>>();
  if (!topicNotify.current) topicNotify.current = new Map();
  // Outstanding retries for topics whose subscribe call failed at the hub.
  const topicRetries = useRef<Map<string, RetryState>>();
  if (!topicRetries.current) topicRetries.current = new Map();
  // Timestamp of the last `topic:status` confirmation (ok=true) per topic.
  // Used for dev observability only; lets us spot silently-dropped
  // subscriptions in long-lived sessions.
  const topicLastConfirmed = useRef<Map<string, number>>();
  if (!topicLastConfirmed.current) topicLastConfirmed.current = new Map();

  const worker = useSignalsWorker({
    onStateChange: ({ state }) => {
      const prevStatus = prevStatusRef.current;
      const hasConnectedAtLeastOnce = hasConnectedAtLeastOnceRef.current;
      if (prevStatus !== state && state === 'connected' && hasConnectedAtLeastOnce) {
        debounce(() => {
          queryUtils.buzz.getBuzzAccount.invalidate();
          queryUtils.orchestrator.queryGeneratedImages.invalidate();
        });
      }

      if (state === 'connected') hasConnectedAtLeastOnceRef.current = true;
      setStatus(state);
    },
  });

  const cancelRetry = useCallback((topic: string) => {
    const retries = topicRetries.current!;
    const prev = retries.get(topic);
    if (prev) {
      clearTimeout(prev.timerId);
      retries.delete(topic);
    }
  }, []);

  const registerTopic = useCallback(
    (topic: TopicString, notify?: boolean) => {
      const refs = topicRefs.current!;
      const count = refs.get(topic) ?? 0;
      refs.set(topic, count + 1);
      topicNotify.current!.set(topic, notify);
      worker?.topicRegister(topic, notify);
      if (count === 0) {
        setRegisteredTopics((prev) => (prev.includes(topic) ? prev : [...prev, topic]));
      }
    },
    [worker]
  );

  const releaseTopic = useCallback(
    (topic: TopicString) => {
      const refs = topicRefs.current!;
      const count = refs.get(topic) ?? 1;
      if (count <= 1) {
        refs.delete(topic);
        topicNotify.current!.delete(topic);
        cancelRetry(topic);
        worker?.topicUnsubscribe(topic);
        setRegisteredTopics((prev) => prev.filter((t) => t !== topic));
      } else {
        refs.set(topic, count - 1);
      }
    },
    [worker, cancelRetry]
  );

  // On every failed `subscribe` / `subscribeNotify`, schedule an exponential-
  // backoff retry — up to RETRY_MAX_ATTEMPTS. `no-connection` failures are
  // skipped (the reconnect effect covers them). A later success clears the
  // retry; a later release clears it too.
  useEffect(() => {
    if (!worker) return;
    const handler: TopicStatusHandler = (status) => {
      if (status.method === 'unsubscribe') return;
      const refs = topicRefs.current!;
      if (status.ok) {
        topicLastConfirmed.current!.set(status.topic, Date.now());
        cancelRetry(status.topic);
        return;
      }
      // Only retry while something still wants this topic.
      if ((refs.get(status.topic) ?? 0) === 0) return;
      // 'no-connection' means the connection dropped; reconnect effect handles it.
      if (status.reason === 'no-connection') return;
      const retries = topicRetries.current!;
      const prev = retries.get(status.topic);
      const nextAttempts = prev ? prev.attempts + 1 : 1;
      if (nextAttempts > RETRY_MAX_ATTEMPTS) {
        if (prev) clearTimeout(prev.timerId);
        retries.delete(status.topic);
        return;
      }
      if (prev) clearTimeout(prev.timerId);
      const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (nextAttempts - 1));
      const timerId = setTimeout(() => {
        // Re-check desired state before retrying.
        if ((topicRefs.current!.get(status.topic) ?? 0) === 0) {
          topicRetries.current!.delete(status.topic);
          return;
        }
        worker.topicRegister(status.topic, topicNotify.current!.get(status.topic));
      }, delay);
      retries.set(status.topic, { timerId, attempts: nextAttempts });
    };
    worker.onTopicStatus(handler);
    return () => worker.offTopicStatus(handler);
  }, [worker, cancelRetry]);

  // Reconnect-driven re-registration. On every transition into 'connected'
  // (including the initial connect), re-register every topic with active
  // subscribers. The hub's group memberships are tied to the SignalR
  // connection and are lost on drop. Running on any 'connected' transition
  // covers initial-mount races (component mounted before worker was ready)
  // and reconnection after drops.
  useEffect(() => {
    if (!worker || status !== 'connected') return;
    const refs = topicRefs.current!;
    for (const topic of refs.keys()) {
      // Cancel any pending retry — fresh reconnect resets the state.
      cancelRetry(topic);
      worker.topicRegister(topic, topicNotify.current!.get(topic));
    }
  }, [status, worker, cancelRetry]);

  // Clean up retry timers on provider unmount.
  useEffect(() => {
    const retries = topicRetries.current!;
    return () => {
      retries.forEach(({ timerId }) => clearTimeout(timerId));
      retries.clear();
    };
  }, []);

  // Dev-only: expose diagnostics + helpers on `window.__signals` so the
  // refcount, retry, and topic-status behavior can be exercised from the
  // console. Guarded by NODE_ENV so it's stripped in production.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return;
    const refs = topicRefs.current!;
    const retries = topicRetries.current!;
    const confirmed = topicLastConfirmed.current!;
    window.__signals = {
      getTopicRefs: () => Object.fromEntries(refs),
      getPendingRetries: () =>
        Object.fromEntries(Array.from(retries, ([t, r]) => [t, { attempts: r.attempts }])),
      getLastConfirmed: () => {
        const now = Date.now();
        return Object.fromEntries(
          Array.from(confirmed, ([t, ts]) => [
            t,
            { ageMs: now - ts, at: new Date(ts).toISOString() },
          ])
        );
      },
      getDeltas: () => ({ ...useMetricSignalsStore.getState().deltas }),
      emitMetric: useMetricSignalsStore.getState().applyDelta,
      clearDeltas: useMetricSignalsStore.getState().clearDelta,
    };
    return () => {
      delete window.__signals;
    };
  }, []);

  const connected = status === 'connected';

  return (
    <SignalContext.Provider
      value={{
        connected,
        status,
        worker,
        registeredTopics,
        setRegisteredTopics,
        registerTopic,
        releaseTopic,
      }}
    >
      {children}
    </SignalContext.Provider>
  );
}

export function SignalStatusNotification({
  title,
  children,
  ...notificationProps
}: Omit<NotificationProps, 'children' | 'color' | 'title'> & {
  children: (status: SignalStatus) => React.ReactNode;
  title?: (status: SignalStatus) => React.ReactNode;
}) {
  const { connected, status } = useSignalContext();
  if (!status || connected) return null;

  return (
    <Notification
      {...notificationProps}
      // onClose={dismiss}
      color={signalStatusDictionary[status]}
      title={title?.(status)}
      withCloseButton={false}
    >
      {children(status)}
    </Notification>
  );
}
