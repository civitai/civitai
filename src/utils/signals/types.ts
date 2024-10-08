import { HubConnectionState } from '@microsoft/signalr';

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

type SignalWorkerReconnecting = {
  type: 'connection:reconnecting';
  message?: string;
};

type SignalWorkerPong = { type: 'pong' };

type SignalEventReceived<T = unknown> = {
  type: 'event:received';
  target: string;
  payload: T;
};

type SignalStatus = {
  type: 'connection:state';
  state?: HubConnectionState;
  message?: string;
};

export type WorkerOutgoingMessage =
  | SignalWorkerReady
  | SignalConnectionStarted
  | SignalConnectionClosed
  | SignalWorkerError
  | SignalWorkerReconnected
  | SignalWorkerReconnecting
  | SignalEventReceived
  | SignalWorkerPong
  | SignalStatus;

export type WorkerIncomingMessage =
  | { type: 'connection:init'; token: string; userId: number }
  | { type: 'event:register'; target: string }
  | { type: 'beforeunload' }
  | { type: 'ping' }
  | { type: 'send'; target: string; args: Record<string, unknown> };
