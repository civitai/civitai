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

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalEventReceived
  | SignalWorkerPong
  | SignalWorkerState;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string; userId: number }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' }
  | { type: 'ping' }
  | { type: 'send'; target: string; args: Record<string, unknown> };
