import { Socket } from 'socket.io-client';

export type ClientType = 'client' | 'sd';

export interface ServerToClientEvents {
  joined: (msg: { type: ClientType }) => void;
  upgradeKey: (msg: { key: string }) => void;
  linkStatus: (active: boolean) => void;
  error: (msg: { msg: string }) => void;
  command: (payload: Command) => void;
  commandStatus: (payload: Response) => void;
}

export type ServerToClientEvent = keyof ServerToClientEvents;
export type ServerToClientMessage = {
  event: ServerToClientEvent;
  payload: Parameters<ServerToClientEvents[ServerToClientEvent]>[0];
};

export interface ClientToServerEvents {
  iam: (msg: { type: ClientType }) => void;
  join: (key: string, callback: (res: { success: boolean; msg?: string }) => void) => void;
  leave: () => void;
  command: (payload: Command) => void;
  commandStatus: (payload: Response) => void;
}

export type ClientToServerEvent = keyof ClientToServerEvents;
export type ClientToServerMessage = {
  event: ClientToServerEvent;
  payload: Parameters<ClientToServerEvents[ClientToServerEvent]>[0];
  callback?: Parameters<ClientToServerEvents[ClientToServerEvent]>[1];
};

export type SocketClient = Socket<ServerToClientEvents, ClientToServerEvents>;

// Civitai Link Commands
// ---------------------

export type ResourceType =
  | 'LORA'
  | 'Checkpoint'
  | 'CheckpointConfig'
  | 'TextualInversion'
  | 'Hypernetwork'
  | 'AestheticGradient';

type CommandBase = {
  id: string;
};

export type CommandResourcesList = CommandBase & {
  type: 'resources:list';
  types?: string[];
};

export type CommandResourcesAdd = CommandBase & {
  type: 'resources:add';
  resources: {
    type: ResourceType;
    hash: string;
    name: string;
    previewImage: string;
    url: string;
  }[];
};

export type CommandResourcesAddCancel = CommandBase & {
  type: 'resources:add:cancel';
  resources: {
    type: ResourceType;
    hash: string;
  }[];
};

export type CommandResourcesRemove = CommandBase & {
  type: 'resources:remove';
  resources: {
    type: ResourceType;
    hash: string;
  }[];
};

export type CommandActivitiesList = CommandBase & {
  type: 'activities:list';
  quantity?: number;
};

export type Command =
  | CommandResourcesList
  | CommandResourcesAdd
  | CommandResourcesRemove
  | CommandResourcesAddCancel
  | CommandActivitiesList;

export type CommandTypes = Command['type'];

export type ResponseStatus = 'pending' | 'processing' | 'success' | 'error' | 'canceled';
type ResponseBase = {
  id: string;
  status: ResponseStatus;
  progress?: number;
  error?: string;
};

export type ResponseResourcesList = ResponseBase & {
  type: 'resources:list';
  resources: {
    type: ResourceType;
    hash: string;
    name: string;
    path: string;
    hasPreview: string;
  }[];
};

export type ResponseResourcesAdd = ResponseBase & {
  type: 'resources:add';
  resources: CommandResourcesAdd['resources'] &
    {
      status: ResponseStatus;
      progress?: number;
      remainingTime?: number; // seconds
      speed?: number; // bytes per second
    }[];
};

export type ResponseResourcesAddCancel = ResponseBase & {
  type: 'resources:add:cancel';
  resources: CommandResourcesAddCancel['resources'] &
    {
      status: ResponseStatus;
    }[];
};

export type ResponseResourcesRemove = ResponseBase & {
  type: 'resources:remove';
  resources: CommandResourcesRemove['resources'] & {
    status: ResponseStatus;
  };
};

export type ResponseActivitesList = ResponseBase & {
  type: 'activities:list';
  activities: Response[];
};

export type Response =
  | ResponseResourcesList
  | ResponseResourcesAdd
  | ResponseResourcesRemove
  | ResponseResourcesAddCancel
  | ResponseActivitesList;
