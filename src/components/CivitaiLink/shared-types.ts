import { Socket } from 'socket.io-client';

export type ClientType = 'client' | 'sd';

export interface ServerToClientEvents {
  kicked: () => void;
  roomPresence: (msg: { client: number; sd: number }) => void;
  upgradeKey: (msg: { key: string }) => void;
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
  | 'LoCon'
  | 'LORA'
  | 'Checkpoint'
  | 'CheckpointConfig'
  | 'TextualInversion'
  | 'Hypernetwork'
  | 'AestheticGradient'
  | 'VAE'
  | 'Controlnet'
  | 'Poses'
  | 'Other'
  | 'Wildcards';

type CommandBase = {
  id: string;
  groupId?: string;
  createdAt: Date;
};

export type CommandResourcesList = {
  type: 'resources:list';
  types?: string[];
};

export type CommandResourcesAdd = {
  type: 'resources:add';
  resource: {
    type: ResourceType;
    hash: string;
    name: string;
    modelName: string;
    modelVersionName?: string;
    previewImage?: string;
    url: string;
  };
};

export type CommandResourcesAddCancel = {
  type: 'activities:cancel';
  activityId: string;
};

export type CommandResourcesRemove = {
  type: 'resources:remove';
  resource: {
    type: ResourceType;
    hash: string;
    modelName: string;
    modelVersionName?: string;
  };
};

export type CommandActivitiesList = {
  type: 'activities:list';
  quantity?: number;
};

export type CommandActivitiesClear = {
  type: 'activities:clear';
};

export type CommandRequest =
  | CommandResourcesList
  | CommandResourcesAdd
  | CommandResourcesRemove
  | CommandResourcesAddCancel
  | CommandActivitiesList
  | CommandActivitiesClear;
export type Command = CommandRequest & CommandBase;

export type CommandTypes = Command['type'];

export type ResponseStatus = 'pending' | 'processing' | 'success' | 'error' | 'canceled';
type ResponseBase = {
  id: string;
  status: ResponseStatus;
  progress?: number;
  error?: string;
  updatedAt?: Date;
  createdAt: Date;
};

export type ResponseResourcesList = ResponseBase & {
  type: 'resources:list';
  resources: {
    type: ResourceType;
    hash: string;
    name: string;
    path?: string;
    hasPreview: string;
    downloading?: boolean;
  }[];
};

export type ResponseResourcesAdd = ResponseBase & {
  type: 'resources:add';
  resource: CommandResourcesAdd['resource'];
  remainingTime?: number; // seconds
  speed?: number; // bytes per second
};

export type ResponseResourcesAddCancel = ResponseBase & {
  type: 'activities:cancel';
  activityId: string;
};

export type ResponseResourcesRemove = ResponseBase & {
  type: 'resources:remove';
  resource: CommandResourcesRemove['resource'];
};

export type ResponseActivitesList = ResponseBase & {
  type: 'activities:list';
  activities: Response[];
};

export type ResponseActivitesClear = ResponseBase & {
  type: 'activities:clear';
  activities: Response[];
};

export type ResponseImageTxt2Img = ResponseBase & {
  type: 'image:txt2img';
  images: string[];
};

export type Response =
  | ResponseResourcesList
  | ResponseResourcesAdd
  | ResponseResourcesRemove
  | ResponseResourcesAddCancel
  | ResponseActivitesList
  | ResponseActivitesClear
  | ResponseImageTxt2Img;

export type ActivitiesResponse = ResponseResourcesAdd | ResponseResourcesRemove;
