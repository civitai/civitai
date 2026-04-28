type SignalWorkerReady = {
  type: 'worker:ready';
};

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
  connectionState: SignalStatus | null;
  connectedUserId: number | null;
  portCount: number;
  registeredEvents: string[];
  lastEventReceivedAt: number | null;
  lastServerPongAt: number | null;
  logEntries: SignalLogEntry[];
  recentSignals: SignalEventEntry[];
  uptime: number;
};

type SignalWorkerDebugDump = {
  type: 'debug:dump';
  data: SignalWorkerStatus;
};

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
  /** Present on failure. `'no-connection'` when the worker wasn't connected. */
  reason?: string;
};

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalEventReceived
  | SignalWorkerPong
  | SignalWorkerState
  | SignalWorkerDebugDump
  | SignalTopicStatus;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string; userId: number }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' }
  | { type: 'ping' }
  | { type: 'send'; target: string; args: Record<string, unknown> }
  | { type: 'topic:register'; topic: string }
  | { type: 'topic:registerNotify'; topic: string }
  | { type: 'topic:unsubscribe'; topic: string }
  | { type: 'debug:dump' }
  | { type: 'debug:toggle-verbose' };
