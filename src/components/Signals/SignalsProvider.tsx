import type { MantineColor, NotificationProps } from '@mantine/core';
import { Notification } from '@mantine/core';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SignalMessages } from '~/server/common/enums';
import type { SignalTopic } from '~/server/common/enums';
import { useDebouncer } from '~/utils/debouncer';
import { getRandomInt } from '~/utils/number-helpers';
import type { SignalStatus } from '~/utils/signals/types';
// import { createSignalWorker, SignalWorker } from '~/utils/signals';
import type { SignalWorker, TopicStatusHandler } from '~/utils/signals/useSignalsWorker';
import { useSignalsWorker } from '~/utils/signals/useSignalsWorker';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import { useSignalTopicsStore } from '~/store/signal-topics.store';
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
       * In steady state, ages should stay <60s thanks to the 50s keep-alive
       * interval. An age >60s on an active topic indicates the keep-alive
       * isn't reaching the hub (e.g., worker stuck, connection issue).
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

// Hub drops topic subscriptions 60s after the last `subscribe` call, so we
// refresh every active topic on a single provider-level interval. 50s gives
// a 10s margin before TTL expiry. One interval for all topics — cheaper than
// per-topic timers, and complementary to the reconnect effect.
const KEEP_ALIVE_INTERVAL_MS = 50_000;

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

// On a signal-hub disruption, ALL connected clients drop and reconnect within
// the same few seconds (the worker's `withAutomaticReconnect` backoff schedule
// starts at 0). Previously each reconnect invalidated `buzz.getBuzzAccount` and
// `orchestrator.queryGeneratedImages` after only an ~8-15s debounce, so a
// fleet-wide reconnect produced tens of thousands of synchronized refetches in
// a single ~10s window — saturating the API's single Node thread (CPU-pin /
// 504 / Error-137 waves). To flatten that spike below the pin threshold we:
//   1. Spread the post-reconnect refetch across a jittered per-client delay
//      window instead of a tight ~10s window.
//   2. Skip the heavy `orchestrator.queryGeneratedImages` refetch for short
//      blips — it self-heals via a 60s poll, so a sub-threshold disconnect
//      cannot have lost durable state. `buzz.getBuzzAccount` is exempt from
//      that gate (it has no polling fallback — a lost `BuzzUpdate` would stick
//      forever) and is always invalidated on reconnect, but still rides the
//      jittered debounce so it stays cheap.
//
// Jitter window for the reconnect-driven invalidate. A uniform random delay in
// [MIN, MAX] per client turns a synchronized fleet spike into refetches spread
// over a full minute. The lower bound stays well above zero so even clients that
// land on the same delay bucket don't all fire at t≈0. We keep the band as
// narrow as the spike-flattening allows so post-outage staleness (worst case ≈
// MAX) stays low — 30-90s smears the fleet across a 60s window while capping
// staleness at ~90s rather than ~3 minutes.
const RECONNECT_INVALIDATE_DELAY_MIN_MS = 30_000;
const RECONNECT_INVALIDATE_DELAY_MAX_MS = 90_000;

// Minimum disconnect duration before a reconnect is allowed to invalidate.
// Live balance/generation deltas are pushed continuously via signal and applied
// with `setData` while connected, so a brief disconnect can't have dropped
// meaningful state. The worker reconnects with backoff [0,2,10,18,...]s and the
// hub keeps group memberships briefly; a disconnect shorter than this almost
// certainly missed no pushes, so refetching would be pure wasted load. We pick
// 10s as a conservative floor: long enough to skip the common instant/near-
// instant reconnects that drive the storm, short enough that any disconnect
// where pushes could realistically have been missed still triggers a refetch
// (which is then spread by the jitter above). When in doubt we still invalidate.
const RECONNECT_INVALIDATE_MIN_DISCONNECT_MS = 10_000;

export function SignalProvider({ children }: { children: React.ReactNode }) {
  const queryUtils = trpc.useUtils();
  // Previous connection state, tracked INSIDE `onStateChange` (not at render
  // time). A render-committed ref lags the event stream — two `connection:state`
  // messages in one tick would both read the same stale value, corrupting the
  // disconnect-gap measurement and potentially leaving `disconnectedAtRef`
  // stale. Updating it as the last line of the handler keeps the gate logic
  // independent of React's render-commit ordering.
  const prevStateRef = useRef<SignalStatus | null>(null);
  const hasConnectedAtLeastOnceRef = useRef(false);
  // Timestamp of when we last LEFT the 'connected' state (transitioned to
  // 'reconnecting' or 'closed'). Used to compute how long the client was
  // actually disconnected when it returns to 'connected'.
  const disconnectedAtRef = useRef<number | null>(null);
  // Pick a single random delay per client, stable across renders. Spreading the
  // delay across clients (not re-rolling it per render) is what flattens the
  // fleet-wide refetch spike; a stable value also keeps `useDebouncer`'s
  // memoized callback/cleanup from churning on every render.
  const reconnectInvalidateDelayRef = useRef<number>();
  if (reconnectInvalidateDelayRef.current === undefined) {
    reconnectInvalidateDelayRef.current = getRandomInt(
      RECONNECT_INVALIDATE_DELAY_MIN_MS,
      RECONNECT_INVALIDATE_DELAY_MAX_MS
    );
  }
  const debounce = useDebouncer(reconnectInvalidateDelayRef.current);

  const [status, setStatus] = useState<SignalStatus | null>(null);
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
      const prevState = prevStateRef.current;
      const hasConnectedAtLeastOnce = hasConnectedAtLeastOnceRef.current;

      // Record when we leave 'connected' so we can measure the disconnect gap
      // on the next reconnect. Only set on the first transition away from
      // 'connected' (don't overwrite on reconnecting → closed) so the gap
      // reflects the full outage, not just the last leg of it.
      if (prevState === 'connected' && state !== 'connected') {
        disconnectedAtRef.current = Date.now();
      }

      if (prevState !== state && state === 'connected' && hasConnectedAtLeastOnce) {
        const disconnectedAt = disconnectedAtRef.current;
        const disconnectedMs = disconnectedAt !== null ? Date.now() - disconnectedAt : Infinity;
        const longDisconnect = disconnectedMs >= RECONNECT_INVALIDATE_MIN_DISCONNECT_MS;

        // Buzz balance has NO polling fallback (staleTime: Infinity,
        // refetchOnWindowFocus: false — see useBuzz.ts); its only live source is
        // the `BuzzUpdate` signal applied via `setData`. A push lost during even
        // a sub-10s blip would leave the balance silently wrong forever, so we
        // ALWAYS invalidate buzz on a genuine reconnect regardless of disconnect
        // duration. This stays cheap: the query is cached (PR #2434) and the
        // invalidate still rides the widened+jittered debounce below, so the
        // fleet spike stays flattened.
        //
        // `orchestrator.queryGeneratedImages` self-heals via a 60s poll (see
        // useGenerationSignalUpdate.ts), so it keeps the 10s disconnect-duration
        // gate — skip the heavier refetch for short blips. Fail-safe: an
        // unknown/null disconnect duration (Infinity) still invalidates.
        debounce(() => {
          queryUtils.buzz.getBuzzAccount.invalidate();
          if (longDisconnect) {
            queryUtils.orchestrator.queryGeneratedImages.invalidate();
          }
        });

        disconnectedAtRef.current = null;
      }

      if (state === 'connected') hasConnectedAtLeastOnceRef.current = true;
      setStatus(state);
      // Track previous state in-handler as the LAST step so the gate above never
      // depends on render-commit ordering. Set on every transition so it can't
      // go stale across rapid flaps.
      prevStateRef.current = state;
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
        useSignalTopicsStore.getState().addTopic(topic);
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
        useSignalTopicsStore.getState().removeTopic(topic);
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

  // Keep-alive: hub drops each registration 60s after the last `subscribe`
  // call, so refresh every active topic on a single provider-level interval.
  // Skip when not connected — the reconnect effect re-registers on the next
  // 'connected' transition.
  useEffect(() => {
    if (!worker) return;
    const interval = setInterval(() => {
      if (status !== 'connected') return;
      const refs = topicRefs.current!;
      const notifyMap = topicNotify.current!;
      for (const topic of refs.keys()) {
        worker.topicRegister(topic, notifyMap.get(topic));
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [worker, status]);

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
    if (typeof window === 'undefined') return;
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
