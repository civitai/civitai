import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import type { ModelMessage, ToolSet } from 'ai';

import {
  chargeOf,
  hasEnded,
  ownedBy,
  savedTurn,
  withCharge,
  withEnd,
  withProgress,
  type EndedReply,
} from './head';
import type { ConversationStore, Logger } from './interfaces';

/** The waits between attempts at saving how a reply ended, after the first fails. */
export const END_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

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
  /** What this writer's model calls were charged in all; `undefined` until one reported a charge. */
  #charged: number | undefined;
  /** What the turn's reply was charged before this writer, read by its first save. */
  #carried: number | undefined;

  constructor(
    private readonly store: ConversationStore,
    private readonly userId: string,
    private readonly conversationId: string,
    private readonly seq: number,
    private readonly log: Logger,
    /** The run saving: once a retry of the same turn took the turn over, this run saves nothing more to it. */
    private readonly runId?: string
  ) {}

  /** A model call of the reply was charged `buzz`: it goes into the head with the next save. */
  charged(buzz: number): void {
    this.#charged = (this.#charged ?? 0) + buzz;
  }

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

  /** Resolves once every save asked for so far has landed or failed. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /**
   * Saves how the reply ended, asking again (`END_RETRY_DELAYS_MS`) when a save fails. Resolves
   * `true` once the head holds an end (this one, or one written before it), `false` when every
   * attempt failed: the caller then keeps what it needs to write it later.
   */
  async end(
    reply: EndedReply,
    delaysMs: readonly number[] = END_RETRY_DELAYS_MS
  ): Promise<boolean> {
    this.#pending = undefined;
    await this.#running;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.#write((head) => withEnd(head, this.seq, reply, new Date()));
      if (outcome !== 'failed') return true;
      const delay = delaysMs[attempt];
      if (delay === undefined) return false;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const messages = this.#pending;
      this.#pending = undefined;
      if (
        (await this.#write((head) => withProgress(head, this.seq, messages, new Date()))) ===
        'written'
      ) {
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
  ): Promise<'written' | 'skipped' | 'failed'> {
    let written = false;
    try {
      await this.store.update(this.userId, this.conversationId, (current) => {
        // Once the reply's end is in the head (this pass's, or a cancel's), nothing replaces it; and a
        // turn a newer run of it owns is that run's alone.
        const turn = current ? savedTurn(current, this.seq) : undefined;
        if (!current || hasEnded(turn)) return null;
        if (this.runId !== undefined && turn && !ownedBy(turn, this.runId)) return null;
        written = true;
        // Read before this writer's first save lands, so a save that landed and then failed is
        // never counted into what came before.
        this.#carried ??= chargeOf(turn?.assistant) ?? 0;
        const next = change(current);
        return this.#charged === undefined
          ? next
          : withCharge(next, this.seq, this.#carried + this.#charged);
      });
      return written ? 'written' : 'skipped';
    } catch (error) {
      this.log.error(
        { err: error, conversationId: this.conversationId, seq: this.seq },
        'saving the reply to the head failed'
      );
      return 'failed';
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
          execute: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
            const run = (async () => {
              await untilAborted(() => saved(options.toolCallId), options.abortSignal);
              return execute(input as never, options as never);
            })();
            // A call the SDK lets go of after an abort must not surface as an unhandled rejection;
            // whoever awaits it still gets the error.
            run.catch(() => undefined);
            return run;
          },
        } as typeof tool)
      : tool;
  }
  return guarded;
}

/** `start()`'s promise, or a rejection as soon as `signal` aborts (a Stop does not wait for a save). */
function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  // Already stopped: the wait is never started, so no timer of it can reject unobserved.
  if (signal?.aborted)
    return Promise.reject(new Error('The reply was stopped before this call ran.'));
  const promise = start();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('The reply was stopped before this call ran.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function callIds(messages: ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
      : []
  );
}
