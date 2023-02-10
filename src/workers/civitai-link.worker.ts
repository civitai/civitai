import { io } from 'socket.io-client';
import {
  SocketClient,
  CommandTypes,
  Command,
  Response,
  ResponseResourcesList,
  ResponseStatus,
  ActivitiesResponse,
} from '~/components/CivitaiLink/shared-types';
import { env } from '~/env/client.mjs';
import { v4 as uuid } from 'uuid';
import {
  CivitaiLinkInstance,
  createLinkInstance,
  deleteLinkInstance,
  getLinkInstances,
  updateLinkInstance,
} from '~/components/CivitaiLink/civitai-link-api';
import {
  WorkerIncomingMessage,
  Instance,
  WorkerOutgoingMessage,
} from '~/workers/civitai-link-worker-types';
import { get, set, del } from 'idb-keyval';

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}
const _self: SharedWorkerGlobalScope = self as any;

// --------------------------------
// Setup Socket
// --------------------------------

const socket: SocketClient = io(env.NEXT_PUBLIC_CIVITAI_LINK, {
  path: '/api/socketio',
  autoConnect: false,
});

// helpers
const sendCommand = (payload: Omit<Command, 'id' | 'createdAt'>) => {
  const _payload = payload as Command;
  _payload.id = uuid();
  _payload.createdAt = new Date();
  socket.emit('command', _payload);
};

// --------------------------------
// Setup shared state
// --------------------------------
const defaultInstance: Instance = {
  id: null,
  key: null,
  name: null,
  connected: false,
  sdConnected: false,
  clientsConnected: 0,
};
let initialized: number | null = null;
let instance: Instance = { ...defaultInstance };
let instances: CivitaiLinkInstance[] | undefined = undefined;
let resources: ResponseResourcesList['resources'] = [];
let activities: ActivitiesResponse[] = [];

// Shared value events
const sharedCallbacks = {
  resources: [] as (() => void)[],
  activities: [] as (() => void)[],
  instance: [] as (() => void)[],
  instances: [] as (() => void)[],
  error: [] as ((msg: string) => void)[],
  message: [] as ((msg: string) => void)[],
  completion: [] as ((response: Response) => void)[],
  socketConnection: [] as ((connected: boolean) => void)[],
};
const onUpdate = (type: UpdateSharedValueProps['type'], cb: () => void) => {
  sharedCallbacks[type].push(cb);
};
type UpdateSharedValueProps =
  | { type: 'resources'; value: ResponseResourcesList['resources'] }
  | { type: 'activities'; value: ActivitiesResponse[] }
  | { type: 'instances'; value: CivitaiLinkInstance[] | undefined }
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
    instance = { ...instance, ...value };
    sharedCallbacks.instance.forEach((cb) => cb());
  } else if (type === 'instances') {
    instances = value;
    sharedCallbacks.instances.forEach((cb) => cb());
  }
};

// Shared socket connection events
const onSocketConnection = (cb: (connected: boolean) => void) => {
  sharedCallbacks.socketConnection.push(cb);
};
const emitSocketConnection = (connected: boolean) => {
  console.log('emitSocketConnection', { connected });
  sharedCallbacks.socketConnection.forEach((cb) => cb(connected));
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

// Storage
const storageKey = 'cl-id';
const storeInstanceId = async () => {
  if (!instance.id) {
    console.log(`${storageKey}: clear`);
    await del(storageKey);
  } else {
    console.log(`${storageKey}: ${instance.id}`);
    await set(storageKey, instance.id.toString());
  }
};

const getStoredInstanceId = async () => {
  const id = await get(storageKey);
  console.log(`${storageKey}: ${id}`);
  if (!id) return null;
  return Number(id);
};

// --------------------------------
// Handle Socket Events
// --------------------------------
socket.on('connect', () => {
  socket.emit('iam', { type: 'client' });
  emitSocketConnection(true);
  if (instance.id) {
    // rejoin if id is set
    initialized = null;
    handleJoin(instance.id);
  }
});
socket.on('disconnect', () => {
  emitSocketConnection(false);
  updateSharedValue({
    type: 'instance',
    value: { connected: false, sdConnected: false, clientsConnected: 0 },
  });
});

const completedStatuses: ResponseStatus[] = ['canceled', 'error', 'success'];
const ignoredCommands: CommandTypes[] = ['activities:cancel'];
socket.on('commandStatus', (payload: Response) => {
  if (ignoredCommands.includes(payload.type)) return;
  if (payload.type === 'resources:list') {
    updateSharedValue({ type: 'resources', value: payload.resources });
    return;
  }

  let value: ActivitiesResponse[] = [];
  if (payload.type === 'activities:list' || payload.type === 'activities:clear') {
    value = payload.activities as ActivitiesResponse[];
  } else {
    let found = false;
    for (const activity of activities) {
      if (activity.id !== payload.id) value.push(activity);
      else {
        found = true;
        value.push(payload as ActivitiesResponse);

        // emit completion if status changed to a completed status
        const activityCompleted =
          activity.status != payload.status && completedStatuses.includes(activity.status);
        if (activityCompleted) emitCompletion(payload);
      }
    }
    if (!found) value.push(payload as ActivitiesResponse);
  }

  updateSharedValue({ type: 'activities', value });
});

socket.on('upgradeKey', ({ key }) => {
  const match = instances?.find((x) => x.id === instance.id);
  if (match) match.key = key;

  updateSharedValue({ type: 'instance', value: { key: null } });
});

socket.on('kicked', () => {
  updateSharedValue({ type: 'instance', value: defaultInstance });
  storeInstanceId();
});

socket.on('error', ({ msg }) => {
  emitError(msg);
});

socket.on('roomPresence', ({ client, sd }) => {
  console.log('roomPresence', { client, sd });
  if (!instance.sdConnected && sd > 0) emitMessage('Stable Diffusion service connected');
  else if (instance.sdConnected && sd === 0) emitMessage('Stable Diffusion service disconnected');

  const connected = sd > 0 && client > 0;
  if (connected && !instance.connected) handleInitialization();
  else if (!connected && instance.connected) initialized = null;
  updateSharedValue({
    type: 'instance',
    value: { sdConnected: sd > 0, clientsConnected: client, connected },
  });
});

// --------------------------------
// Handle Incoming Messages
// --------------------------------
const handleJoin = (id: number) => {
  if (instance.id === id && instance.connected) return;

  const targetInstance = instances?.find((i) => i.id === id);
  if (!targetInstance) {
    storeInstanceId();
    emitError('Could not find instance');
    return;
  }
  const { key, name } = targetInstance;

  if (!socket.connected) {
    socket.connect();
    socket.emit('iam', { type: 'client' });
  }

  socket.emit('join', targetInstance.key, ({ success, msg }) => {
    const isShortKey = key.length < 10;
    if (!success && msg) emitError(msg);
    else updateSharedValue({ type: 'instance', value: { id, key: isShortKey ? key : null, name } });
  });
};

const handleLeave = () => {
  if (!instance.id) return;
  socket.emit('leave');
  updateSharedValue({
    type: 'instance',
    value: defaultInstance,
  });
  storeInstanceId();
};

const handleCommand = (payload: Command) => {
  if (!instance.connected) {
    emitError('Your link is not ready for commands');
    return;
  }
  socket.emit('command', { ...payload, createdAt: new Date() });
};

const handleLoadInstances = async () => {
  try {
    const result = await getLinkInstances();
    updateSharedValue({ type: 'instances', value: result });
  } catch (err: any) {
    updateSharedValue({ type: 'instances', value: undefined });
    emitError(`Error loading instances: ${err.message}`);
  }
};

const handleRename = async (id: number, name: string) => {
  try {
    await updateLinkInstance({ id, name });
    if (instance.id === id) updateSharedValue({ type: 'instance', value: { name } });
    await handleLoadInstances();
  } catch (err: any) {
    emitError(`Error renaming instance: ${err.message}`);
  }
};

const handleDelete = async (id: number) => {
  try {
    if (instance.id === id) handleLeave();
    await deleteLinkInstance(id);
    await handleLoadInstances();
  } catch (err: any) {
    emitError(`Error deleting instance: ${err.message}`);
  }
};

const handleCreate = async (id?: number) => {
  try {
    const result = await createLinkInstance(id);
    await handleLoadInstances();
    handleJoin(result.id);
  } catch (err: any) {
    emitError(`Error creating instance: ${err.message}`);
  }
};

const handleInitialization = () => {
  if (!instance.id || initialized === instance.id) return;

  sendCommand({ type: 'activities:list' });
  sendCommand({ type: 'resources:list' });
  initialized = instance.id;
  console.log(`Initialized instance: ${instance.id}`);
  storeInstanceId();
};

// --------------------------------
// Bootstrap Worker
// --------------------------------
const start = async (port: MessagePort) => {
  if (!port.postMessage) return;

  const portReq = (req: WorkerOutgoingMessage) => port.postMessage(req);

  onError((msg) => portReq({ type: 'error', msg }));
  onMessage((msg) => portReq({ type: 'message', msg }));
  onCompletion((payload) => portReq({ type: 'commandComplete', payload }));
  portReq({ type: 'instance', payload: instance });
  onUpdate('instance', () => {
    portReq({ type: 'instance', payload: instance });
  });
  portReq({ type: 'resourcesUpdate', payload: resources });
  onUpdate('resources', () => {
    portReq({ type: 'resourcesUpdate', payload: resources });
  });
  portReq({ type: 'activitiesUpdate', payload: activities });
  onUpdate('activities', () => {
    portReq({ type: 'activitiesUpdate', payload: activities });
  });
  portReq({ type: 'instancesUpdate', payload: instances });
  onUpdate('instances', () => {
    portReq({ type: 'instancesUpdate', payload: instances });
  });
  portReq({ type: 'socketConnection', payload: socket.connected });
  onSocketConnection((connected) => {
    portReq({ type: 'socketConnection', payload: connected });
  });

  port.onmessage = ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'join') handleJoin(data.id);
    else if (data.type === 'create') handleCreate(data.id);
    else if (data.type === 'delete') handleDelete(data.id);
    else if (data.type === 'rename') handleRename(data.id, data.name);
    else if (data.type === 'leave') handleLeave();
    else if (data.type === 'command') handleCommand(data.payload);
  };

  handleLoadInstances().finally(async () => {
    portReq({ type: 'ready' });
    const storedInstanceId = await getStoredInstanceId();
    if (storedInstanceId) handleJoin(Number(storedInstanceId));
  });
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback, just in case the browser doesn't support SharedWorkers natively
if ('SharedWorkerGlobalScope' in _self) start(_self as any); // eslint-disable-line @typescript-eslint/no-explicit-any
