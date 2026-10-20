import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import type { ModelMessage, ToolSet } from 'ai';

import { withEnd, withProgress, type EndedReply } from './head';
import type { ConversationStore, Logger } from './interfaces';

/** How long a tool call waits for its start to be saved before it fails without running. */
export const CALL_SAVE_TIMEOUT_MS = 15_000;

/**
 * Saves a reply's progress to the head one save at a time: progress that comes in while a save is
 * on its way goes with the next one (only the latest matters), and the end goes after all of it.
 */
export class ProgressWriter {
  #pending: ModelMessage[] | undefined;
  #running: Promise<void> | undefined;
  readonly #savedCalls = new Set<string>();
  readonly #waiting = new Map<string, (() => void)[]>();

  constructor(
    private readonly store: ConversationStore,
    private readonly userId: string,
    private readonly conversationId: string,
    private readonly seq: number,
    private readonly log: Logger
  ) {}

  save(messages: ModelMessage[]): void {
    this.#pending = messages;
    this.#running ??= this.#drain();
  }

  /**
   * Resolves once a save that names the call `toolCallId` has landed, so a crash after it never
   * runs the call again (the next pass closes it as interrupted). Rejects after `timeoutMs`.
   */
  async callSaved(toolCallId: string, timeoutMs = CALL_SAVE_TIMEOUT_MS): Promise<void> {
    if (this.#savedCalls.has(toolCallId)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The reply could not save that this call started, so it was not run.'));
      }, timeoutMs);
      const waiters = this.#waiting.get(toolCallId) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#waiting.set(toolCallId, waiters);
    });
  }

  async end(reply: EndedReply): Promise<void> {
    this.#pending = undefined;
    await this.#running;
    await this.#write((head) => withEnd(head, this.seq, reply, new Date()));
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const messages = this.#pending;
      this.#pending = undefined;
      if (await this.#write((head) => withProgress(head, this.seq, messages, new Date()))) {
        for (const id of callIds(messages)) this.#markSaved(id);
      }
    }
    this.#running = undefined;
  }

  #markSaved(id: string): void {
    this.#savedCalls.add(id);
    for (const resolve of this.#waiting.get(id) ?? []) resolve();
    this.#waiting.delete(id);
  }

  async #write(
    change: (head: StoredConversationMetadata) => StoredConversationMetadata
  ): Promise<boolean> {
    try {
      const head = await this.store.update(this.userId, this.conversationId, (current) =>
        current ? change(current) : null
      );
      return head !== null;
    } catch (error) {
      this.log.error(
        { err: error, conversationId: this.conversationId, seq: this.seq },
        'saving the reply to the head failed'
      );
      return false;
    }
  }
}

/** `tools` whose calls each wait, before running, until `saved` says their start is saved. */
export function runAfterSaved(
  tools: ToolSet,
  saved: (toolCallId: string) => Promise<void>
): ToolSet {
  const guarded: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    guarded[name] = execute
      ? ({
          ...tool,
          execute: async (input: unknown, options: { toolCallId: string }) => {
            await saved(options.toolCallId);
            return execute(input as never, options as never);
          },
        } as typeof tool)
      : tool;
  }
  return guarded;
}

function callIds(messages: ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
      : []
  );
}
