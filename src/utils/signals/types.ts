// Bump with any tab ↔ worker protocol change, and with any change to how the worker talks to the hub.
// It names the SharedWorker and versions its URL, and a tab that gets a different version back is
// talking to a stale script (e.g. mid rolling deploy). A SharedWorker outlives the deploy that loaded
// it for as long as any tab still holds it, so without a bump new tabs would keep joining the old
// script — 2.3 replaced a fixed 5s hub retry, so joining 2.2 would keep that.
export const SIGNALS_WORKER_VERSION = '2.3';

// Tabs heartbeat on this interval; the worker treats a port silent for PORT_STALE_AFTER_MS as a tab
// that died without `beforeunload`. Hidden tabs throttle timers to ~1/min, so keep a wide margin.
export const PORT_HEARTBEAT_INTERVAL_MS = 30_000;
export const PORT_STALE_AFTER_MS = 3 * 60_000;

type SignalWorkerReady = {
  type: 'worker:ready';
  /** Absent on scripts older than 2.2. */
  version?: string;
};

/** The worker dropped this port's topics as stale; the tab must re-send them. */
type SignalWorkerPortReset = { type: 'port:reset' };

type SignalWorkerPong = { type: 'pong' };

type SignalEventReceived<T = unknown> = {
  type: 'event:received';
  target: string;
  payload: T;
};

export type SignalStatus = 'connected' | 'closed' | 'reconnecting';
export type SignalConnectionState = {
  state: SignalStatus | null;
  message?: string;
};
type SignalWorkerState = {
  type: 'connection:state';
} & SignalConnectionState;

// Debug types
export type SignalLogEntry = {
  ts: number;
  type: string;
  detail?: string;
};

export type SignalEventEntry = {
  ts: number;
  target: string;
  payload: unknown;
};

export type SignalWorkerStatus = {
  version?: string;
  connectionState: SignalStatus | null;
  connectionMessage?: string;
  /** The SignalR HubConnection's own state; can disagree with `connectionState`. */
  hubState: string | null;
  connectionId: string | null;
  connectedUserId: number | null;
  /** Hub `start()` failures since the last connect, and when the next attempt is due. Absent before 2.3. */
  connectRetry?: { failures: number; nextAttemptAt: number | null };
  portCount: number;
  registeredEvents: string[];
  /** Topics any tab wants subscribed → whether as `subscribeNotify`. */
  topics: Record<string, boolean>;
  lastEventReceivedAt: number | null;
  lastServerPongAt: number | null;
  lastServerActivityAt: number | null;
  logEntries: SignalLogEntry[];
  recentSignals: SignalEventEntry[];
  uptime: number;
};

type SignalWorkerDebugDump = {
  type: 'debug:dump';
  data: SignalWorkerStatus;
};

export type SignalServerPingResult = { ok: boolean; ms: number; error?: string };
type SignalWorkerServerPong = { type: 'debug:server-pong' } & SignalServerPingResult;

export type SignalTopicMethod = 'subscribe' | 'subscribeNotify' | 'unsubscribe';

/**
 * Result of a `topicInvoke` call on the hub. Broadcast to all ports so the
 * main-thread provider can retry failed subscribes and surface subscription
 * state to consumers.
 */
export type SignalTopicStatus = {
  type: 'topic:status';
  topic: string;
  method: SignalTopicMethod;
  ok: boolean;
  /**
   * Present on failure. `'no-connection'` when the worker wasn't connected; `'timeout'` when the hub
   * didn't answer in time (the call may still land, so don't pile retries on it).
   */
  reason?: string;
};

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalEventReceived
  | SignalWorkerPong
  | SignalWorkerState
  | SignalWorkerDebugDump
  | SignalWorkerServerPong
  | SignalWorkerPortReset
  | SignalTopicStatus;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string; userId: number; tokenFetchedAt: number }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' }
  | { type: 'ping' }
  | { type: 'port:heartbeat' }
  | { type: 'send'; target: string; args: Record<string, unknown> }
  | { type: 'topic:register'; topic: string }
  | { type: 'topic:registerNotify'; topic: string }
  | { type: 'topic:unsubscribe'; topic: string }
  | { type: 'debug:dump' }
  | { type: 'debug:toggle-verbose' }
  | { type: 'debug:server-ping' }
  | { type: 'debug:reconnect' };
