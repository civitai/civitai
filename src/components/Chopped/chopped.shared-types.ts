import { Socket } from 'socket.io-client';

// #region [connection]
export type ClientType = 'client' | 'sd';

export interface ServerToClientEvents {
  kicked: () => void;
  error: (msg: { msg: string }) => void;
  updateGlobal: (global: Partial<GlobalState>) => void;
  updateGame: (game: Partial<GameState>) => void;
}

export type ServerToClientEvent = keyof ServerToClientEvents;
export type ServerToClientMessage = {
  event: ServerToClientEvent;
  payload: Parameters<ServerToClientEvents[ServerToClientEvent]>[0];
};

export interface ClientToServerEvents {
  new: (req: NewGame, callback: (res: {success: boolean; msg?: string })) => void;
  join: (req: JoinGame, callback: (res: { success: boolean; msg?: string }) => void) => void;
  leave: () => void;
  command: (payload: Command) => void;
}

export type ClientToServerEvent = keyof ClientToServerEvents;
export type ClientToServerMessage = {
  event: ClientToServerEvent;
  payload: Parameters<ClientToServerEvents[ClientToServerEvent]>[0];
  callback?: Parameters<ClientToServerEvents[ClientToServerEvent]>[1];
};

export type SocketClient = Socket<ServerToClientEvents, ClientToServerEvents>;
// #endregion

// #region [types]
export type GlobalState = {
  themes: Theme[];
  judges: Judge[];
};

export type GameState = {
  code: string;
  round: number;
  status: 'setup' | 'joining' | 'playing' | 'complete';
  judgeIds: string[]; // list of judgeIds
  rounds: Round[];
  users: User[];
  hostId: string; // userId
  includeAudio: boolean;
};

export type Judge = {
  id: string;
  name: string;
  avatar: string; // url
  voiceId: string; // ElevenLabs voiceId
  context: string; // Explaining who the judge is
  shortDescription: string; // One-liner
};

export type Round = {
  status: 'pending' | 'submissions' | 'judging' | 'showing' | 'awarding' | 'complete';
  themeId: string;
  duration: number; // seconds
  submissions: Submission[];
  showcaseIds?: number[]; // the submission Ids to display (shuffled and popped)
  judgeId?: string;
  judgeDecisionText?: string;
  judgeDecisionAudio?: string;
  decisionType: 'elimination' | 'winner';
  decisionsNeeded: number; // how many people to eliminate or win
  decisionUsers: string[]; // list of userIds
};

export type Theme = {
  id: string;
  name: string;
  description: string; // Given to judges as context
  judgingCriteria: string; // Given to judges as context
  image?: string; // url
};

export type Submission = {
  id: string;
  userId: string;
  image: string; // base64
  judgeId?: string;
  judgeCritiqueText?: string;
  judgeCritiqueAudio?: string;
  judgeScore?: number; // 1-10 scale: 1-4: thumbs down, 5-7: thumbs up, 8-10: heart
};

export type User = {
  id: string;
  status: 'missing' | 'playing' | 'eliminated' | 'winner' | 'viewer';
  name: string;
  socketId: string; // Backend only
};
// #endregion

// #region [commands]
export type NewGame = {
  themeIds: string[];
  judgeIds: string[];
  name: string;
  includeAudio: boolean;
  viewOnly: boolean;
};

export type JoinGame = {
  code: string;
  name: string;
};

export type CommandRoundContinue = {
  type: 'round.continue';
};

export type CommandRoundSubmit = {
  type: 'round.submit';
  image: string; // base64
};

export type CommandGameAgain = {
  type: 'game.again';
};

export type Command = CommandRoundContinue | CommandRoundSubmit | CommandGameAgain;
// #endregion
