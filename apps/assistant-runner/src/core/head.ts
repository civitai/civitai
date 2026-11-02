import { turnFrom } from '@civitai/components-chat/core';
import type {
  ConversationMetadata,
  ConversationMetadataV3,
  ResumePoint,
  SavedTurnV3,
  StoredConversationMetadata,
  TurnUser,
} from '@civitai/components-chat/core';
import type { ConversationPatchRequest, RunEvent } from '@civitai/components-chat/runner-protocol';
import type { ModelMessage } from 'ai';

/**
 * Pure edits of the conversation head, written so the chat package's own reader (`turnFrom`,
 * `conversationMetadataOf`) reads them as it reads a head the browser runner saved: v2 between
 * replies, v3 while a reply is saved `running`.
 */

/** How a reply ended, as the head keeps it. The chat saves these extra fields too (`saved()` keeps them). */
export interface EndedReply {
  messages: ModelMessage[];
  status: 'done' | 'error' | 'aborted';
  error?: string;
  errorDetail?: string;
  errorKind?: string;
  ranOut?: boolean;
  stopped?: string;
  /** What the reply's model calls were charged, in Buzz (the chat's `assistant.buzz`, which its spend readout sums). */
  buzz?: number;
}

/** The charge a saved reply carries (`EndedReply.buzz`), when it has one. */
export const chargeOf = (assistant: HeadTurn['assistant']): number | undefined => {
  const buzz = (assistant as { buzz?: unknown } | undefined)?.buzz;
  return typeof buzz === 'number' && Number.isFinite(buzz) ? buzz : undefined;
};

type Head = StoredConversationMetadata;
/**
 * A saved turn, with the run that owns it (`runId`) when the runner started it: the latest run
 * started for that turn (a retry of the same turn takes it over). An extra field the chat's own
 * reader (`turnFrom`, `conversationMetadataOf`) ignores. The runner's store keeps it as written, but
 * the browser runner's `ThreadStore` (components-chat) rebuilds every turn through `turnFrom`
 * when it saves, which drops it: after a save in browser mode the turn has no owner again, and the
 * runner writes it under the old rules (any run of the turn may), which fails open. A turn saved
 * before the runner recorded owners has none either.
 */
export type HeadTurn = SavedTurnV3 & { runId?: string };

export function lastSeq(head: Head | null): number {
  return Math.max(0, ...(head?.turns ?? []).map((turn) => turn.seq));
}

/**
 * Whether a start may reply to `seq`: the next turn, or with `retry` (or `edit`, the user's latest
 * message edited) the latest turn again, or the next one when the first start of it was refused
 * before anything saved it.
 */
export function acceptsTurn(head: Head | null, seq: number, retry: boolean, edit = false): boolean {
  const last = lastSeq(head);
  return retry || edit ? seq === last || seq === last + 1 : seq === last + 1;
}

export interface TurnStart {
  conversationId: string;
  scope?: string;
  seq: number;
  user: TurnUser;
  now: Date;
  /** Saved steps the reply carries on from: saved at once as `running`, so the head shows them. */
  from?: ResumePoint;
  /** The run starting this reply: it owns the turn from now on, and an older run's writes to it stop. */
  runId?: string;
  /**
   * The user edited this message: `user` replaces the saved one (a chat still named after its first
   * message is named after the edited one). Without it, a turn already saved keeps its message.
   */
  edit?: boolean;
  /**
   * The chat's own model. A chat picks it before anything is saved and sends it with its first run
   * only, so a new head keeps it; an existing head keeps its own (a later change arrives as a patch).
   */
  model?: string;
}

/** The head with the user's turn saved as the reply starts (a new head when there is none). */
export function startTurn(head: Head | null, start: TurnStart): Head {
  const now = start.now.toISOString();
  const base: Head = head ?? {
    v: 2,
    app: 'chat-cvt',
    conversationId: start.conversationId,
    title: firstMessageTitle(start.user.content),
    titleSource: 'first-message',
    createdAt: now,
    updatedAt: now,
    turns: [],
    ...(start.scope ? { scope: start.scope } : {}),
    ...(start.model ? { model: start.model } : {}),
  };
  const existing = base.turns.find((turn) => turn.seq === start.seq);
  const renamed =
    start.edit && start.seq === 1 && head !== null && base.titleSource === 'first-message'
      ? { title: firstMessageTitle(start.user.content) }
      : {};
  const turn: HeadTurn = {
    seq: start.seq,
    createdAt: existing?.createdAt ?? now,
    user: start.edit ? start.user : existing?.user ?? start.user,
    ...(start.runId ? { runId: start.runId } : {}),
    ...(start.from
      ? {
          assistant: {
            messages: start.from.messages,
            status: 'running',
            savedAt: now,
            ...charged(chargeOf(existing?.assistant)),
          },
        }
      : {}),
  };
  const turns = [...(base.turns as HeadTurn[]).filter((t) => t.seq < start.seq), turn];
  return versioned({ ...base, ...renamed, updatedAt: now }, turns);
}

/** The head with the reply saved `running` as far as `messages` go (a call with no result started and did not finish). */
export function withProgress(head: Head, seq: number, messages: ModelMessage[], now: Date): Head {
  const savedAt = now.toISOString();
  return replaceReply(head, seq, { messages, status: 'running', savedAt }, savedAt);
}

/** The head with how the reply ended. */
export function withEnd(head: Head, seq: number, reply: EndedReply, now: Date): Head {
  return replaceReply(head, seq, reply as HeadTurn['assistant'] & object, now.toISOString());
}

/**
 * The head with turn `seq`'s reply charged `buzz` in all, once it has one saved; the head as it is
 * otherwise. A total, not an increment, so writing it twice counts it once.
 */
export function withCharge(head: Head, seq: number, buzz: number): Head {
  const turn = savedTurn(head, seq);
  if (!turn?.assistant) return head;
  return replaceReply(head, seq, { ...turn.assistant, ...charged(buzz) }, head.updatedAt);
}

export function withPatch(head: Head, patch: ConversationPatchRequest, now: Date): Head {
  const next = { ...head, updatedAt: now.toISOString() } as Head;
  if (patch.title !== undefined) {
    next.title = patch.title;
    next.titleSource = patch.titleSource ?? 'user';
  }
  if (patch.model === null) delete next.model;
  else if (patch.model !== undefined) next.model = patch.model;
  return next;
}

/** The saved turn `seq`, when the head has it. */
export function savedTurn(head: Head | null, seq: number): HeadTurn | undefined {
  return (head?.turns as HeadTurn[] | undefined)?.find((turn) => turn.seq === seq);
}

/**
 * Where a reply saved `running` carries on from, read as the chat reads it: its saved steps, every
 * call that finished with its result and every call that did not with the "interrupted" result, so
 * nothing runs twice. `undefined` when it saved no step, or has no step left to take.
 */
export function resumeOf(turn: HeadTurn): ResumePoint | undefined {
  if (turn.assistant?.status !== 'running') return undefined;
  return turnFrom(turn).assistant.resume;
}

/** What the reply shows, read as the chat reads it (a reply saved `running` with its unfinished calls closed). */
export function shownMessages(turn: HeadTurn | undefined): ModelMessage[] {
  return turn ? turnFrom(turn).assistant.messages : [];
}

/** The error kind of a reply that was cut off with its finished steps kept: Continue carries on from them. */
export const INTERRUPTED = 'interrupted';

/** Whether the turn's reply has ended in the head (it is saved, and not `running`). */
export function hasEnded(turn: HeadTurn | undefined): boolean {
  return turn?.assistant !== undefined && turn.assistant.status !== 'running';
}

/**
 * Whether `runId` may write the turn's reply: the turn is its own, or has no recorded owner (saved
 * before owners were, or by the browser). A run a retry of the same turn took over owns it no more.
 */
export function ownedBy(turn: HeadTurn | undefined, runId: string): turn is HeadTurn {
  return turn !== undefined && (turn.runId === undefined || turn.runId === runId);
}

/** Whether `runId` may still save the turn's reply: its own, and not ended yet. */
export function writableBy(turn: HeadTurn | undefined, runId: string): turn is HeadTurn {
  return ownedBy(turn, runId) && !hasEnded(turn);
}

/** `run-ended` for a reply whose end the head saved: how the client hears an end the journal lacks. */
export function endedEvent(turn: HeadTurn): Extract<RunEvent, { type: 'run-ended' }> {
  const reply = (turn.assistant ?? { messages: [], status: 'error' }) as EndedReply;
  const messages = reply.messages ?? [];
  const steps = messages.filter((message) => message.role === 'assistant').length;
  if (reply.status === 'done') {
    return {
      type: 'run-ended',
      status: reply.ranOut ? 'ran_out' : 'done',
      messages,
      steps,
      ...(reply.stopped !== undefined ? { endedBy: reply.stopped } : {}),
    };
  }
  if (reply.status === 'aborted') return { type: 'run-ended', status: 'stopped', messages, steps };
  return {
    type: 'run-ended',
    status: 'error',
    messages,
    steps,
    resumable: reply.errorKind === INTERRUPTED && steps > 0,
  };
}

/**
 * Where a retry of a reply that ended interrupted carries on from: its saved steps, every call in
 * them already answered (a call that had not finished carries the interrupted result).
 */
export function interruptedResume(turn: HeadTurn | undefined): ResumePoint | undefined {
  const reply = turn?.assistant as EndedReply | undefined;
  if (reply?.status !== 'error' || reply.errorKind !== INTERRUPTED || !reply.messages.length)
    return undefined;
  const steps = reply.messages.filter((message) => message.role === 'assistant').length;
  return { messages: reply.messages, steps, at: Date.now() };
}

function replaceReply(
  head: Head,
  seq: number,
  assistant: HeadTurn['assistant'],
  updatedAt: string
): Head {
  // A reply saved again keeps what it was charged so far unless the save says otherwise.
  const turns = (head.turns as HeadTurn[]).map((turn) => {
    if (turn.seq !== seq) return turn;
    const kept = chargeOf(turn.assistant);
    return {
      ...turn,
      assistant:
        assistant && chargeOf(assistant) === undefined
          ? { ...assistant, ...charged(kept) }
          : assistant,
    };
  });
  return versioned({ ...head, updatedAt }, turns);
}

function charged(buzz: number | undefined): { buzz?: number } {
  return buzz === undefined ? {} : { buzz };
}

/** v3 while any reply is saved `running`, v2 otherwise, as the chat writes them. */
function versioned(head: Head, turns: HeadTurn[]): Head {
  const running = turns.some((turn) => turn.assistant?.status === 'running');
  return running
    ? ({ ...head, v: 3, turns } satisfies ConversationMetadataV3)
    : ({
        ...head,
        v: 2,
        turns: turns as ConversationMetadata['turns'],
      } satisfies ConversationMetadata);
}

/** Whether two user messages are the same one: the same words, files and references, in order. */
export function sameMessage(a: TurnUser, b: TurnUser): boolean {
  const ids = (user: TurnUser) => (user.attachments ?? []).map((attachment) => attachment.id);
  return (
    a.content === b.content &&
    JSON.stringify(ids(a)) === JSON.stringify(ids(b)) &&
    JSON.stringify(a.refs ?? []) === JSON.stringify(b.refs ?? [])
  );
}

/** The chat's own first-message title (`firstMessageTitle` in its thread store, not in the package's exports). */
export function firstMessageTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'New chat';
  if (flat.length <= 40) return flat;
  const cut = flat.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
}
