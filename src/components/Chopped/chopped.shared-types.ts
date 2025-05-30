import type { Socket } from 'socket.io-client';
import type { Difference } from '~/utils/object-helpers';

export interface ServerToClientEvents {
  kicked: () => void;
  error: (msg: string) => void;
  updateGlobal: (global: GlobalState) => void;
  updateGame: (game: GameState) => void;
  patchGame: (game: Difference[]) => void;
  setUserId: (user: { userId: string; token: string }) => void;
  message: (msg: string) => void;
}

export type ServerToClientEvent = keyof ServerToClientEvents;
export type ServerToClientMessage = {
  event: ServerToClientEvent;
  payload: Parameters<ServerToClientEvents[ServerToClientEvent]>[0];
};

export interface ClientToServerEvents {
  new: (req: NewGame, callback: (res: { success: boolean; msg?: string }) => void) => void;
  join: (req: JoinGame, callback: (res: { success: boolean; msg?: string }) => void) => void;
  leave: () => void;
  continue: (callback: (res: { success: boolean; msg?: string }) => void) => void;
  submit: (image: string, callback: (res: { success: boolean; msg?: string }) => void) => void;
  gameAgain: () => void;
  reconnect: (token: string) => void;
  retry: () => void;
}

export type ClientToServerEvent = keyof ClientToServerEvents;
export type ClientToServerMessage = {
  event: ClientToServerEvent;
  payload: Parameters<ClientToServerEvents[ClientToServerEvent]>[0];
  callback?: Parameters<ClientToServerEvents[ClientToServerEvent]>[1];
};

export type SocketClient = Socket<ServerToClientEvents, ClientToServerEvents>;

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
  rounds: Record<string, Round>;
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
export type JudgeStatus = 'text' | 'audio' | 'complete';

export type Theme = {
  id: string;
  name: string;
  resources?: string[]; // AIRs
  image?: string; // url
};

export type Round = {
  status: 'pending' | 'submissions' | 'judging' | 'showing' | 'deciding' | 'awarding' | 'complete';
  themeId: string;
  duration: number; // seconds
  submissions: Submission[];
  submissionsOpenedAt?: number; // timestamp
  showcaseIds: Record<string, boolean>; // the submission Ids to display (shuffled and popped)
  judgeId?: string;
  judgeStatus?: JudgeStatus;
  judgeDecisionText?: string;
  judgeDecisionAudio?: string;
  decisionType: 'elimination' | 'winner';
  decisionsNeeded: number; // how many people to eliminate or win
  decisionUsers: Record<string, boolean>; // list of userIds
};
export type RoundStatus = Round['status'];

export type Submission = {
  id: string;
  userId: string;
  image: string; // base64
  judgeId?: string;
  judgeStatus?: JudgeStatus;
  judgeCritiqueText?: string;
  judgeCritiqueAudio?: string;
  judgeScore?: number; // 1-10 scale: 1-4: thumbs down, 5-7: thumbs up, 8-10: heart
  judgeCriticalness?: number; // 0-10
};

export type User = {
  id: string;
  status: 'playing' | 'eliminated' | 'winner' | 'viewer';
  connected?: boolean;
  name: string;
};

export type NewGame = {
  themeIds: string[];
  judgeIds: string[];
  name: string;
  includeAudio: boolean;
  viewOnly: boolean;
  maxPlayers: number;
  code?: string;
};

export type JoinGame = {
  code: string;
  name: string;
};
// #endregion
