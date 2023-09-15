export type SignalWorkerReady = {
  type: 'worker:ready';
};

export type SignalConnectionStarted = {
  type: 'connection:ready';
};

export type SignalConnectionClosed = {
  type: 'connection:closed';
  message?: string;
};

export type SignalWorkerError = {
  type: 'connection:error';
  message?: string;
};

export type SignalEventReceived<T = unknown> = {
  type: 'event:received';
  target: string;
  payload: T;
};

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalConnectionStarted
  | SignalConnectionClosed
  | SignalWorkerError
  | SignalEventReceived;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' };
