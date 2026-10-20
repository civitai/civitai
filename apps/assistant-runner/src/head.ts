import type {
  ResumePoint,
  SavedTurnV3,
  StoredConversationMetadata,
  TurnUser,
} from '@civitai/components-chat/core';
import type { ConversationPatchRequest } from '@civitai/components-chat/runner-protocol';
import type { ModelMessage } from 'ai';

// Stub: the head edits land in the next commit.
export interface EndedReply {
  messages: ModelMessage[];
  status: 'done' | 'error' | 'aborted';
  error?: string;
  errorDetail?: string;
  errorKind?: string;
  ranOut?: boolean;
  stopped?: string;
}

export interface TurnStart {
  conversationId: string;
  scope?: string;
  seq: number;
  user: TurnUser;
  now: Date;
  from?: ResumePoint;
}

type Head = StoredConversationMetadata;

const stub = (): never => {
  throw new Error('not implemented');
};

export const lastSeq = (_head: Head | null): number => stub();
export const acceptsTurn = (_head: Head | null, _seq: number, _retry: boolean): boolean => stub();
export const startTurn = (_head: Head | null, _start: TurnStart): Head => stub();
export const withProgress = (_head: Head, _seq: number, _m: ModelMessage[], _now: Date): Head =>
  stub();
export const withEnd = (_head: Head, _seq: number, _reply: EndedReply, _now: Date): Head => stub();
export const withPatch = (_head: Head, _patch: ConversationPatchRequest, _now: Date): Head =>
  stub();
export const savedTurn = (_head: Head | null, _seq: number): SavedTurnV3 | undefined => stub();
export const resumeOf = (_turn: SavedTurnV3): ResumePoint | undefined => stub();
export const shownMessages = (_turn: SavedTurnV3 | undefined): ModelMessage[] => stub();
export const firstMessageTitle = (_content: string): string => stub();
