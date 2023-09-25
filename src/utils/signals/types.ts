type SignalWorkerReady = {
  type: 'worker:ready';
};

type SignalConnectionStarted = {
  type: 'connection:ready';
};

type SignalConnectionClosed = {
  type: 'connection:closed';
  message?: string;
};

type SignalWorkerError = {
  type: 'connection:error';
  message?: string;
};

type SignalWorkerReconnected = {
  type: 'connection:reconnected';
};

type SignalEventReceived<T = unknown> = {
  type: 'event:received';
  target: string;
  payload: T;
};

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalConnectionStarted
  | SignalConnectionClosed
  | SignalWorkerError
  | SignalWorkerReconnected
  | SignalEventReceived;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' };
