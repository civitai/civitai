import type { SignalStatus, SignalWorkerStatus } from '~/utils/signals/types';
import { SIGNALS_WORKER_VERSION } from '~/utils/signals/types';
import type {
  AnySignalHandler,
  SignalWorker,
  TopicStatusHandler,
} from '~/utils/signals/useSignalsWorker';

// Hub drops a topic subscription 60s after the last subscribe; the worker's keep-alive must stay under this.
const TOPIC_TTL_MS = 60_000;

export type TopicFailure = { at: number; reason: string };

type CheckResult = 'ok' | 'warn' | 'fail' | 'info';
type Check = { check: string; result: CheckResult; detail: string; fix?: string };

type WatchFilter = string | RegExp | ((target: string, payload: unknown) => boolean);
type Watcher = { attach: (worker: SignalWorker) => () => void; detach: () => void };

export type SignalsDebugDeps = {
  getWorker: () => SignalWorker | null;
  getProviderStatus: () => SignalStatus | null;
  topicRefs: Map<string, number>;
  topicRetries: Map<string, { attempts: number }>;
  topicLastConfirmed: Map<string, number>;
  topicLastFailure: Map<string, TopicFailure>;
  resubscribeAll: () => void;
};

const icons: Record<CheckResult, string> = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };

const ago = (ts: number | null | undefined) =>
  ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : 'never';

const HELP = `window.__signals — signals debugging
  diagnose()            run every health check and print what looks wrong (start here)
  status()              connection snapshot: tab, worker, hub, topics
  watch(filter?)        log incoming signals live; filter = target name | RegExp | (target, payload) => bool
                        returns a stop function; a target name also registers that target with the hub
  unwatch()             stop every watch()
  recent()              the worker's last 50 signals (shared across tabs)
  log(limit = 50)       the worker's event log (connection, topics, heartbeats, SignalR internals)
  pingServer()          round-trip through the WebSocket — fails on a zombie connection
  reconnect()           drop the hub connection; the tab fetches a fresh token and reconnects
  resubscribe()         re-send subscribe for every active topic now
  verbose()             toggle the worker echoing its log to the worker console
  subscribers()         handlers per signal target in this tab
  getTopicRefs() / getPendingRetries() / getLastConfirmed() / getTopicFailures()
  getDeltas() / emitMetric(...) / clearDeltas(...)   metric-signals store helpers`;

export function createSignalsDebug(deps: SignalsDebugDeps) {
  const watchers = new Set<Watcher>();

  const requireWorker = () => {
    const worker = deps.getWorker();
    if (!worker) console.warn('[signals] No worker yet — is SignalProvider mounted?');
    return worker;
  };

  const getTopicTable = () => {
    const now = Date.now();
    return Array.from(deps.topicRefs, ([topic, refs]) => {
      const confirmedAt = deps.topicLastConfirmed.get(topic);
      const failure = deps.topicLastFailure.get(topic);
      return {
        topic,
        refs,
        confirmed: confirmedAt ? `${Math.round((now - confirmedAt) / 1000)}s ago` : 'never',
        expired: !confirmedAt || now - confirmedAt > TOPIC_TTL_MS,
        retryAttempt: deps.topicRetries.get(topic)?.attempts,
        lastFailure: failure ? `${failure.reason} (${ago(failure.at)})` : undefined,
      };
    });
  };

  async function status() {
    const worker = requireWorker();
    if (!worker) return null;
    const workerStatus = await worker.debug.getWorkerStatus();
    const tab = { providerStatus: deps.getProviderStatus(), ...worker.debug.getState() };
    if (!workerStatus) {
      console.warn('[signals] Worker did not answer — run __signals.diagnose()');
      console.log('[signals] Tab:', tab);
      return { tab, worker: null, topics: getTopicTable() };
    }
    const { logEntries: _logs, recentSignals: _recent, ...summary } = workerStatus;
    const topics = getTopicTable();
    console.log('[signals] Tab:', tab);
    console.log('[signals] Worker:', summary);
    console.log(
      `[signals] Last signal: ${ago(summary.lastEventReceivedAt)} · last server pong: ${ago(
        summary.lastServerPongAt
      )} · worker uptime: ${Math.round(summary.uptime / 1000)}s`
    );
    if (topics.length) console.table(topics);
    else console.log('[signals] No active topics in this tab');
    return { tab, worker: summary, topics };
  }

  async function diagnose() {
    const worker = requireWorker();
    if (!worker) return [];
    const checks: Check[] = [];
    const add = (check: string, result: CheckResult, detail: string, fix?: string) =>
      checks.push({ check, result, detail, fix });

    const tab = worker.debug.getState();
    const providerStatus = deps.getProviderStatus();

    if (!tab.userId)
      add('signed in', 'fail', 'No user', 'Signals connect for signed-in users only');
    else add('signed in', 'ok', `userId ${tab.userId}`);

    if (tab.tokenStatus === 'error')
      add('token', 'fail', `signals.getToken failed: ${tab.tokenError}`, 'Check the network tab');
    else if (!tab.hasToken && tab.connection === 'closed')
      add('token', 'warn', 'No token yet while closed — still fetching?');
    else add('token', 'ok', tab.hasToken ? 'present' : 'not needed (connection open)');

    const workerRtt = await worker.debug.pingWorker();
    const workerStatus: SignalWorkerStatus | null =
      workerRtt === null ? null : await worker.debug.getWorkerStatus();
    if (!workerStatus) {
      add(
        'worker',
        'fail',
        'SharedWorker did not answer within 2s',
        'Kill it in chrome://inspect/#workers (or close every civitai tab), then reload'
      );
    } else {
      add(
        'worker',
        'ok',
        `answered in ${workerRtt}ms · ${workerStatus.portCount} tab(s) attached · up ${Math.round(
          workerStatus.uptime / 1000
        )}s`
      );
      if (workerStatus.version !== SIGNALS_WORKER_VERSION)
        add(
          'worker version',
          'fail',
          `worker script is ${
            workerStatus.version ?? 'pre-2.2'
          }, tab expects ${SIGNALS_WORKER_VERSION} (retry ${tab.staleScriptRetry})`,
          'Close every civitai tab, then reopen'
        );
      if (!tab.ready)
        add(
          'worker ready',
          'warn',
          'Tab marked the worker not-ready, so it will not send connection:init',
          'Switch tabs away and back, or reload'
        );

      const { connectionState, connectionMessage, hubState, connectedUserId } = workerStatus;
      const stateDetail = `${connectionState ?? 'null'}${
        connectionMessage ? ` — ${connectionMessage}` : ''
      } (hub: ${hubState ?? 'no connection'})`;
      if (connectionState === 'connected') add('connection', 'ok', stateDetail);
      else if (connectionState === 'reconnecting')
        add(
          'connection',
          'warn',
          stateDetail,
          'the worker retries on its backoff (watch log()); __signals.reconnect() skips the wait'
        );
      else add('connection', 'fail', stateDetail, '__signals.reconnect()');

      if (connectionState === 'connected' && hubState !== 'Connected')
        add(
          'hub state',
          'fail',
          `worker says connected but HubConnection is ${hubState ?? 'missing'}`,
          '__signals.reconnect()'
        );

      if (providerStatus !== connectionState)
        add(
          'tab in sync',
          'warn',
          `tab thinks ${providerStatus ?? 'null'}, worker is ${connectionState ?? 'null'}`,
          'The tab missed a connection:state message; switch tabs away and back'
        );

      if (tab.userId && connectedUserId !== tab.userId)
        add(
          'user',
          'fail',
          `worker connected as ${connectedUserId ?? 'nobody'}, tab is ${tab.userId}`,
          '__signals.reconnect()'
        );

      if (connectionState === 'connected') {
        const pong = await worker.debug.pingServer();
        if (!pong) add('server ping', 'fail', 'Worker did not report a result');
        else if (pong.ok && pong.error)
          add('server ping', 'warn', `socket alive, but the hub answered: ${pong.error}`);
        else if (pong.ok) add('server ping', 'ok', `${pong.ms}ms`);
        else
          add(
            'server ping',
            'fail',
            `${pong.error} after ${pong.ms}ms — zombie connection`,
            '__signals.reconnect()'
          );
      }

      add(
        'server activity',
        'info',
        `last signal ${ago(workerStatus.lastEventReceivedAt)} · last server activity ${ago(
          workerStatus.lastServerActivityAt
        )} (the worker pings after 3 min of silence)`
      );
    }

    const topics = getTopicTable();
    if (!topics.length) add('topics', 'info', 'No active topics in this tab');
    for (const t of topics) {
      if (workerStatus && !(t.topic in workerStatus.topics))
        add(
          `topic ${t.topic}`,
          'fail',
          'This tab holds the topic but the worker is not keeping it subscribed',
          '__signals.resubscribe()'
        );
      else if (t.expired)
        add(
          `topic ${t.topic}`,
          'fail',
          `last confirmed ${t.confirmed}; the hub drops it after ${TOPIC_TTL_MS / 1000}s${
            t.lastFailure ? ` · last failure: ${t.lastFailure}` : ''
          }`,
          '__signals.resubscribe()'
        );
      else if (t.retryAttempt || t.lastFailure)
        add(
          `topic ${t.topic}`,
          'warn',
          `retry ${t.retryAttempt ?? '-'} · last failure: ${t.lastFailure ?? '-'}`
        );
      else add(`topic ${t.topic}`, 'ok', `confirmed ${t.confirmed}`);
    }

    const failed = checks.filter((c) => c.result === 'fail').length;
    const warned = checks.filter((c) => c.result === 'warn').length;
    console.table(
      checks.map(({ check, result, detail, fix }) => ({
        '': icons[result],
        check,
        detail,
        fix: fix ?? '',
      }))
    );
    console.log(
      failed || warned
        ? `[signals] ${failed} failing, ${warned} warning`
        : '[signals] All checks passed. If signals still look dead, try watch() while triggering one.'
    );
    return checks;
  }

  function watch(filter?: WatchFilter) {
    const worker = requireWorker();
    if (!worker) return () => undefined;

    const log = (target: string, payload: unknown) =>
      console.log(
        `%c[signal] ${new Date().toLocaleTimeString()} ${target}`,
        'color:#22c55e',
        payload
      );
    const logTopic: TopicStatusHandler = (s) => {
      if (!s.ok)
        console.log(`%c[signals] ${s.method} ${s.topic} failed: ${s.reason}`, 'color:#ef4444');
    };
    const matches = (target: string, payload: unknown) =>
      !filter ||
      (typeof filter === 'string'
        ? filter === target
        : filter instanceof RegExp
        ? filter.test(target)
        : filter(target, payload));
    const logSignal: AnySignalHandler = ({ target, payload }) => {
      if (matches(target, payload)) log(target, payload);
    };
    // A target name must be registered with the hub, or the worker never forwards it.
    const registerTarget = () => undefined;

    const attach = (w: SignalWorker) => {
      w.onTopicStatus(logTopic);
      w.onAnySignal(logSignal);
      if (typeof filter === 'string') w.on(filter, registerTarget);
      return () => {
        w.offTopicStatus(logTopic);
        w.offAnySignal(logSignal);
        if (typeof filter === 'string') w.off(filter, registerTarget);
      };
    };
    const watcher: Watcher = { attach, detach: attach(worker) };
    watchers.add(watcher);

    console.log(
      `[signals] Watching ${
        filter ? String(filter) : 'all signals'
      }. Stop with the returned function or __signals.unwatch().`
    );
    if (typeof filter !== 'string') {
      const registered = Object.keys(worker.debug.getSubscriberCounts());
      console.log(`[signals] Targets registered with the hub: ${registered.join(', ') || 'none'}`);
    }
    return () => {
      watcher.detach();
      watchers.delete(watcher);
    };
  }

  return {
    help: () => console.log(HELP),
    status,
    diagnose,
    watch,
    unwatch: () => {
      watchers.forEach((w) => w.detach());
      watchers.clear();
    },
    /** Re-attaches running watches to a replaced worker; its predecessor's handlers died with it. */
    rebindWatchers: () => {
      const worker = deps.getWorker();
      if (!worker) return;
      for (const w of watchers) {
        w.detach();
        w.detach = w.attach(worker);
      }
    },
    recent: async () => {
      const s = await requireWorker()?.debug.getWorkerStatus();
      if (!s) return [];
      for (const { ts, target, payload } of s.recentSignals)
        console.log(`${new Date(ts).toLocaleTimeString()} ${target}`, payload);
      if (!s.recentSignals.length) console.log('[signals] No signals received yet');
      return s.recentSignals;
    },
    log: async (limit = 50) => {
      const s = await requireWorker()?.debug.getWorkerStatus();
      if (!s) return [];
      const entries = s.logEntries.slice(-limit);
      console.table(
        entries.map((e) => ({
          time: new Date(e.ts).toLocaleTimeString(),
          type: e.type,
          detail: e.detail ?? '',
        }))
      );
      return entries;
    },
    pingServer: async () => {
      const result = await requireWorker()?.debug.pingServer();
      console.log('[signals] Server ping:', result ?? 'worker did not answer');
      return result ?? null;
    },
    reconnect: () => {
      requireWorker()?.debug.forceReconnect();
      console.log('[signals] Reconnect requested; run status() in a few seconds');
    },
    resubscribe: () => {
      deps.resubscribeAll();
      console.log(`[signals] Re-subscribed ${deps.topicRefs.size} topic(s)`);
    },
    verbose: () => {
      requireWorker()?.debug.toggleVerbose();
      console.log('[signals] Toggled verbose logging (shows in the worker console)');
    },
    subscribers: () => {
      const counts = requireWorker()?.debug.getSubscriberCounts() ?? {};
      console.table(counts);
      return counts;
    },
    getTopicRefs: () => Object.fromEntries(deps.topicRefs),
    getPendingRetries: () =>
      Object.fromEntries(Array.from(deps.topicRetries, ([t, r]) => [t, { attempts: r.attempts }])),
    getLastConfirmed: () => {
      const now = Date.now();
      return Object.fromEntries(
        Array.from(deps.topicLastConfirmed, ([t, ts]) => [
          t,
          { ageMs: now - ts, at: new Date(ts).toISOString() },
        ])
      );
    },
    getTopicFailures: () =>
      Object.fromEntries(
        Array.from(deps.topicLastFailure, ([t, f]) => [
          t,
          { reason: f.reason, at: new Date(f.at).toISOString() },
        ])
      ),
  };
}

export type SignalsDebugApi = ReturnType<typeof createSignalsDebug>;
