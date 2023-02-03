import { io } from 'socket.io-client';
import {
  SocketClient,
  CommandTypes,
  Command,
  Response,
  ResponseResourcesList,
  ResponseStatus,
} from '~/components/CivitaiLink/shared-types';
import { env } from '~/env/client.mjs';
import { v4 as uuid } from 'uuid';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}
const _self: SharedWorkerGlobalScope = self as any;

type IncomingMessage =
  | { type: 'join'; key: string }
  | { type: 'leave' }
  | { type: 'command'; payload: Command };

type Instance = { key: string | null; connected: boolean };

// --------------------------------
// Setup Socket
// --------------------------------

const socket: SocketClient = io(env.NEXT_PUBLIC_CIVITAI_LINK, {
  path: '/api/socketio',
  autoConnect: false,
});

// helpers
const sendCommand = (payload: Omit<Command, 'id'>) => {
  const _payload = payload as Command;
  _payload.id = uuid();
  socket.emit('command', _payload);
};

// --------------------------------
// Setup shared state
// --------------------------------
let initialized = false;
const instance: Instance = {
  key: null,
  connected: false,
};
let resources: ResponseResourcesList['resources'] = [];
let activities: Response[] = [];

// Shared value events
const sharedCallbacks = {
  resources: [] as (() => void)[],
  activities: [] as (() => void)[],
  instance: [] as (() => void)[],
  error: [] as ((msg: string) => void)[],
  message: [] as ((msg: string) => void)[],
  completion: [] as ((response: Response) => void)[],
};
const onUpdate = (type: 'resources' | 'activities' | 'instance', cb: () => void) => {
  sharedCallbacks[type].push(cb);
};
type UpdateSharedValueProps =
  | { type: 'resources'; value: ResponseResourcesList['resources'] }
  | { type: 'activities'; value: Response[] }
  | { type: 'instance'; value: Partial<Instance> };
const updateSharedValue = ({ type, value }: UpdateSharedValueProps) => {
  console.log('updateSharedValue', { type, value });
  if (type === 'resources') {
    resources = value;
    sharedCallbacks.resources.forEach((cb) => cb());
  } else if (type === 'activities') {
    activities = value;
    sharedCallbacks.activities.forEach((cb) => cb());
  } else if (type === 'instance') {
    if (value.key) instance.key = value.key;
    if (value.connected) instance.connected = value.connected;
    sharedCallbacks.instance.forEach((cb) => cb());
  }
};

// Shared completion events
const onCompletion = (cb: (response: Response) => void) => {
  sharedCallbacks.completion.push(cb);
};
const emitCompletion = (response: Response) => {
  console.log('emitCompletion', { response });
  sharedCallbacks.completion.forEach((cb) => cb(response));
};

// Shared error events
const onError = (cb: (msg: string) => void) => {
  sharedCallbacks.error.push(cb);
};
const emitError = (msg: string) => {
  console.log('emitError', { msg });
  sharedCallbacks.error.forEach((cb) => cb(msg));
};

// Shared message events
const onMessage = (cb: (msg: string) => void) => {
  sharedCallbacks.message.push(cb);
};
const emitMessage = (msg: string) => {
  console.log('emitMessage', { msg });
  sharedCallbacks.message.forEach((cb) => cb(msg));
};

// --------------------------------
// Handle Socket Events
// --------------------------------
socket.on('linkStatus', (active: boolean) => {
  updateSharedValue({ type: 'instance', value: { connected: active } });
});

const completedStatuses: ResponseStatus[] = ['canceled', 'error', 'success'];
const ignoredCommands: CommandTypes[] = ['resources:add:cancel'];
socket.on('commandStatus', (payload: Response) => {
  if (ignoredCommands.includes(payload.type)) return;
  if (payload.type === 'resources:list') {
    updateSharedValue({ type: 'resources', value: payload.resources });
    return;
  }

  let value: Response[] = [];
  if (payload.type === 'activities:list') {
    value = payload.activities;
  } else {
    let found = false;
    for (const activity of activities) {
      if (activity.id !== payload.id) value.push(activity);
      else {
        found = true;
        value.push(payload);

        // emit completion if status changed to a completed status
        const activityCompleted =
          activity.status != payload.status && completedStatuses.includes(activity.status);
        if (activityCompleted) emitCompletion(payload);
      }
    }
    if (!found) value.push(payload);
  }

  updateSharedValue({ type: 'activities', value });
});

socket.on('error', ({ msg }) => {
  emitError(msg);
});

socket.on('joined', ({ type }) => {
  if (type === 'client') return; // ignore client joins
  else if (type === 'sd') emitMessage('Stable Diffusion service connected');
});

// --------------------------------
// Handle Incoming Messages
// --------------------------------
const handleJoin = (key: string) => {
  if (instance.key === key && instance.connected) return;

  if (!socket.connected) {
    socket.connect();
    socket.emit('iam', { type: 'client' });
  }

  socket.emit('join', key, ({ success, msg }) => {
    updateSharedValue({ type: 'instance', value: { key } });
    if (!success && msg) emitError(msg);
  });
};

const handleLeave = () => {
  if (!instance.key) return;
  socket.emit('leave');
  updateSharedValue({ type: 'instance', value: { key: null, connected: false } });
};

const handleCommand = (payload: Command) => {
  if (!instance.key) {
    emitError('You must join a session before sending commands');
    return;
  }
  socket.emit('command', payload);
};

const handleInitialization = () => {
  sendCommand({ type: 'activities:list' });
  sendCommand({ type: 'resources:list' });
  initialized = true;
};

// --------------------------------
// Bootstrap Worker
// --------------------------------
const start = (port: MessagePort) => {
  if (!port.postMessage) return;

  onError((msg) => port.postMessage({ type: 'error', msg }));
  onMessage((msg) => port.postMessage({ type: 'message', msg }));
  onCompletion((payload) => port.postMessage({ type: 'commandComplete', payload }));
  port.postMessage({ type: 'instance', payload: instance });
  onUpdate('instance', () => {
    if (instance.connected && !initialized) handleInitialization();
    port.postMessage({ type: 'instance', payload: instance });
  });
  port.postMessage({ type: 'resourcesUpdate', payload: resources });
  onUpdate('resources', () => {
    port.postMessage({ type: 'resourcesUpdate', payload: resources });
  });
  port.postMessage({ type: 'activitiesUpdate', payload: activities });
  onUpdate('activities', () => {
    port.postMessage({ type: 'activitiesUpdate', payload: activities });
  });

  port.onmessage = ({ data }: { data: IncomingMessage }) => {
    if (data.type === 'join') handleJoin(data.key);
    else if (data.type === 'leave') handleLeave();
    else if (data.type === 'command') handleCommand(data.payload);
  };

  port.postMessage({ type: 'ready' });
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback, just in case the browser doesn't support SharedWorkers natively
if ('SharedWorkerGlobalScope' in _self) start(_self as any); // eslint-disable-line @typescript-eslint/no-explicit-any
