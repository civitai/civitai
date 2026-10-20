import type { IncomingHttpHeaders } from 'node:http';

import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import type { RunPageState } from '@civitai/components-chat/runner-protocol';
import type { LanguageModel, ToolSet } from 'ai';

/**
 * The four seams PR A fakes and PR B fills in. None of them is handed a credential by the runner:
 * the runner passes a user id, and an implementation that needs a token mints it itself, per call,
 * inside its own fetch. Anything passed to a DBOS workflow or returned from a step is persisted in
 * Postgres, so a token must never cross these interfaces as an argument or a return value.
 */

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; message: string };

/** Turns a request into the viewer it acts for. Sees the headers; returns only a user id. */
export interface Authenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<AuthResult>;
}

export interface ModelContext {
  userId: string;
  runId: string;
  /** The model the start asked for, unvalidated: the provider decides whether the viewer may use it. */
  model: string;
}

/** The model a reply asks with. Called once per pass of a reply; a real one mints its token per request. */
export interface ModelProvider {
  languageModel(context: ModelContext): LanguageModel;
}

export interface ToolContext {
  userId: string;
  runId: string;
  conversationId: string;
  page?: RunPageState;
  /** Aborted when the run stops or ends. */
  signal: AbortSignal;
}

export interface OpenTools {
  tools: ToolSet;
  /** Closes every transport the tools hold; the only way to reach a call still running on a tool server. */
  close(): Promise<void>;
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

export interface Logger {
  info(object: object, message?: string): void;
  warn(object: object, message?: string): void;
  error(object: object, message?: string): void;
}
