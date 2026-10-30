import type { IncomingHttpHeaders } from 'node:http';

import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import type {
  ChatToolResult,
  RunPageState,
  RunSettings,
  RunSubagentProgress,
} from '@civitai/components-chat/runner-protocol';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';

import type { EndedReply } from './head';

/**
 * The seams a deployment fills in (tests use fakes): everything under `core/` reaches the deployment
 * only through these and the options of `Runner` and `buildRunApp`. The model and tool seams are never handed a credential by the runner: it passes
 * a user id, and an implementation that needs a token mints it itself, per call, inside its own
 * fetch. Anything passed to a DBOS workflow or returned from a step is persisted in Postgres, so a
 * token must never cross the model, tool or conversation-store seams as an argument or a return value.
 * The run grant is the one credential the runner holds: it goes to the grant store, and a patch's own
 * grant reaches the conversation store's calls out of band (`withRequestGrant`), never into DBOS.
 */

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; message: string };

/** Turns a request into the viewer it acts for. Sees the headers; returns only a user id. */
export interface Authenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<AuthResult>;
}

/**
 * A run grant the deployment verified (civitai's is a signed JWT, `tokens.ts`): who it acts for, in
 * which conversation, for which start, until when. The runner keeps `token` in its grant store, never
 * in DBOS.
 */
export interface RunGrant {
  /** The grant itself, as its issuer signed it. */
  token: string;
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  expiresAt: Date;
  /** The viewer may start read-only subagents. */
  subagents?: boolean;
  /**
   * A grant for one request other than a run (civitai's preview grant): good only where a route
   * asks for one, and never for a start or a patch.
   */
  preview?: boolean;
}

/** Checks a run grant a request carries. */
export interface GrantVerifier {
  /** The grant, or `null` when it is not a valid, current one. */
  grant(token: string): Promise<RunGrant | null>;
}

export interface ModelContext {
  userId: string;
  runId: string;
  conversationId: string;
  /** The model the start asked for, unvalidated: the provider decides whether the viewer may use it. */
  model: string;
  /** How the viewer pays for replies: free while it lasts then Buzz (`auto`), `free` only, or `paid`. */
  tier: RunSettings['tier'];
  /** Aborted when the run stops or ends. */
  signal?: AbortSignal;
  /** The turn the reply answers. */
  seq?: number;
  /**
   * The reply carries on from steps an earlier run of the same turn saved (a retry of a reply that
   * ended in error or was interrupted): a request that run had in flight may be answered for it.
   */
  carriesOn?: boolean;
  /** Told what each of the reply's model calls was charged, in Buzz, as the provider learns it. */
  onCharge?: (buzz: number) => void;
}

/** The model a reply asks with. Called once per pass of a reply; a real one mints its token per request. */
export interface ModelProvider {
  languageModel(context: ModelContext): LanguageModel;
  /**
   * Waits, briefly, for what the run's requests left to do when they were cut off (cancelling a
   * model call in flight), and forgets the run. Called as each pass ends, before its end is saved
   * and its grant goes.
   */
  settle?(runId: string): Promise<void>;
}

export interface ToolContext {
  userId: string;
  runId: string;
  conversationId: string;
  /** What the page said about itself as the reply started, unvalidated: the provider validates it. */
  page?: RunPageState;
  /** Aborted when the run stops or ends. */
  signal: AbortSignal;
  /**
   * What the conversation already did, for a gate that decides on it: the messages of its earlier
   * replies, and those of this reply's saved steps when it carries on.
   */
  history?: { earlier: ModelMessage[]; current: ModelMessage[] };
  /** civitai's grant says the viewer may start read-only subagents. */
  subagents?: boolean;
  /** The reply's own model (subagents ask it too), and the most one step may write. */
  model?(): LanguageModel;
  maxOutputTokens?: number;
  /** Tells the page a call finished, as its gate saw it: journaled as `tool-reported`. */
  report?(result: ChatToolResult): void;
  /**
   * Ends the reply now as interrupted, with these words: Continue carries on from its saved steps.
   * For a tool that cannot go on (its app was paused by the user opening another).
   */
  endReply?(message: string): void;
  /** Tells the page how a subagent is doing: journaled as `subagent-progress`. */
  subagentProgress?(toolCallId: string, progress: RunSubagentProgress | null): void;
}

export interface OpenTools {
  tools: ToolSet;
  /** Closes every transport the tools hold; the only way to reach a call still running on a tool server. */
  close(): Promise<void>;
  /** The system prompt's rules, given the chat's defaults (as `<civitai-chat>`'s `systemPrompt`). */
  rules?(defaults: string): string;
  /** The reply's per-turn instructions, in place of the page's own (`settings.hostInstructions`). */
  instructions?: string;
  /** The tools the system prompt names as the embedding app's own. */
  hostTools?: string[];
}

/** Opens a reply's tools, closed by the runner on Stop or when the reply ends. */
export interface ToolProvider {
  open(context: ToolContext): Promise<OpenTools>;
}

/**
 * Where the conversation head (the saved conversation, `@civitai/components-chat`'s v2/v3 metadata)
 * lives. In remote mode the runner is its only writer.
 */
export interface ConversationStore {
  load(userId: string, conversationId: string): Promise<StoredConversationMetadata | null>;
  /**
   * Replaces the head with what `change` returns, atomically per conversation; `null` leaves it as it
   * is. Resolves with the head as it now stands.
   */
  update(
    userId: string,
    conversationId: string,
    change: (head: StoredConversationMetadata | null) => StoredConversationMetadata | null
  ): Promise<StoredConversationMetadata | null>;
}

/** A run grant as the runner keeps it for one run (see `grants.ts`). */
export interface StoredGrant {
  token: string;
  userId: string;
  conversationId: string;
  expiresAt: Date;
}

/** A reply end a run journaled but could not save to the head, kept to be written later. */
export interface PendingEnd {
  runId: string;
  userId: string;
  conversationId: string;
  seq: number;
  reply: EndedReply;
}

/**
 * Where a run's grant lives while the run does: a runner-owned table keyed by run id, never a DBOS
 * workflow argument, step output or journal value, so a run a restarted process recovers can still
 * mint, and the grant goes when the run's end is in the head.
 */
export interface GrantStore {
  save(runId: string, grant: StoredGrant): Promise<void>;
  delete(runId: string): Promise<void>;
  /** Deletes the run's grant unless an end of it is still waiting to be saved. */
  forgetUnlessEndPending(runId: string): Promise<void>;
  /** Keeps the run's grant, with the end it could not save, until that end is written. */
  markEndPending(runId: string, seq: number, reply: EndedReply): Promise<void>;
  /** The ends waiting to be saved whose grants are still live. */
  pendingEnds(): Promise<PendingEnd[]>;
  /** Deletes expired grants. Returns how many. */
  sweep(): Promise<number>;
}

export interface Logger {
  info(object: object, message?: string): void;
  warn(object: object, message?: string): void;
  error(object: object, message?: string): void;
}
