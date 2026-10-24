import {
  APP_TAG,
  conversationMetadataOf,
  conversationTag,
  HEAD_TAG,
  scopeTag,
  TURN_TAG,
  type StoredConversationMetadata,
} from '@civitai/components-chat/core';
import type pg from 'pg';

import { lastSeq } from './head';
import type { ConversationStore, Logger } from './interfaces';
import type { TokenSource } from './minter';
import type { OrchestrationClient, Workflow } from './orchestration';

/** The longest a write waits for another writer of the same conversation. */
const LOCK_WAIT_MS = 120_000;

/** Runs `fn` with the conversation's head to itself, across every replica. */
export interface ConversationLock {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A Postgres session advisory lock in the runner's own database, per conversation. Held on its own
 * connection for the length of one read-change-write; a process that dies drops its connection and
 * with it the lock.
 */
export class AdvisoryLock implements ConversationLock {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      // Bounded: a writer that never gets the lock fails loudly instead of holding its connection.
      await client.query(`set lock_timeout = '${LOCK_WAIT_MS}ms'`);
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [key]);
      try {
        return await fn();
      } finally {
        await client
          .query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch((error: Error) => (broken = error));
      }
    } finally {
      // A connection whose unlock failed may still hold the lock: closing it lets the lock go.
      client.release(broken);
    }
  }
}

interface Head {
  workflowId: string;
  metadata: StoredConversationMetadata;
}

export interface OrchestrationStoreOptions {
  orchestration: OrchestrationClient;
  /** The token source to read and write this user's conversation with (minted from a grant). */
  tokens(userId: string, conversationId: string): TokenSource;
  lock: ConversationLock;
  log: Logger;
}

/**
 * The conversation head where the browser keeps it: orchestration `echo` workflows tagged
 * `cvt:head`, one per turn, the conversation in the workflow's metadata, exactly as the chat's
 * `ThreadStore` (`@civitai/components-chat` 0.25.0) writes and reads them. So a conversation
 * started on the runner opens in the browser, and one started in the browser carries on here.
 *
 * A new turn is a new workflow (`externalId` `cvt-head-<conversation>-<seq>`, so a save retried
 * after a crash finds the same one), and the previous head loses its `cvt:head` tag; anything else
 * replaces the current head's metadata. Every request goes as the viewer, with a `chat` token the
 * runner minted from their grant, so orchestration only ever shows it that viewer's workflows.
 */
export class OrchestrationConversationStore implements ConversationStore {
  readonly #options: OrchestrationStoreOptions;

  constructor(options: OrchestrationStoreOptions) {
    this.#options = options;
  }

  async load(userId: string, conversationId: string): Promise<StoredConversationMetadata | null> {
    return (
      (await this.#head(this.#options.tokens(userId, conversationId), conversationId))?.metadata ??
      null
    );
  }

  async update(
    userId: string,
    conversationId: string,
    change: (head: StoredConversationMetadata | null) => StoredConversationMetadata | null
  ): Promise<StoredConversationMetadata | null> {
    const source = this.#options.tokens(userId, conversationId);
    // Minted before the lock is taken, so a lock (and its connection) is never held across a mint;
    // only a fresh token after an orchestration 401 is minted under it.
    const token = await source('chat');
    const tokens: TokenSource = (purpose, options) =>
      options?.fresh ? source(purpose, options) : Promise.resolve(token);
    return this.#options.lock.run(`cvt-head:${userId}:${conversationId}`, async () => {
      const head = await this.#head(tokens, conversationId);
      const next = change(head ? structuredClone(head.metadata) : null);
      if (!next) return head?.metadata ?? null;
      await this.#write(tokens, conversationId, head, next);
      return next;
    });
  }

  async #head(tokens: TokenSource, conversationId: string): Promise<Head | undefined> {
    const page = await this.#options.orchestration.queryWorkflows(tokens, {
      tags: [APP_TAG, HEAD_TAG, conversationTag(conversationId)],
      take: 5,
    });
    return newestHead(page.items ?? [], conversationId);
  }

  async #write(
    tokens: TokenSource,
    conversationId: string,
    head: Head | undefined,
    next: StoredConversationMetadata
  ): Promise<void> {
    const { orchestration, log } = this.#options;
    const seq = lastSeq(next);
    if (head && lastSeq(head.metadata) >= seq) {
      await orchestration.updateWorkflow(tokens, head.workflowId, { metadata: next });
      return;
    }
    const submitted = await orchestration.submitWorkflow(tokens, {
      steps: [{ $type: 'echo', name: 'turn', input: { message: 'chat-cvt turn' } }],
      tags: [
        APP_TAG,
        TURN_TAG,
        HEAD_TAG,
        conversationTag(conversationId),
        ...(next.scope ? [scopeTag(next.scope)] : []),
      ],
      metadata: next,
      externalId: `cvt-head-${conversationId}-${seq}`,
    });
    const workflowId = submitted?.id;
    if (!workflowId) throw new Error('orchestration saved the turn without an id');
    // A save of this turn that landed before (a retry after a crash) hands back that workflow as it was.
    if (JSON.stringify(submitted.metadata) !== JSON.stringify(next))
      await orchestration.updateWorkflow(tokens, workflowId, { metadata: next });
    if (head && head.workflowId !== workflowId) {
      // Best effort, as in the browser: a reader takes the head with the latest turn either way.
      await orchestration
        .removeTag(tokens, head.workflowId, HEAD_TAG)
        .catch((error: unknown) =>
          log.warn(
            { err: (error as Error)?.message, conversationId },
            'an older save still counts as the latest'
          )
        );
    }
  }
}

function newestHead(workflows: Workflow[], conversationId: string): Head | undefined {
  let best: Head | undefined;
  for (const workflow of workflows) {
    const metadata = conversationMetadataOf(
      workflow as Parameters<typeof conversationMetadataOf>[0]
    );
    if (!metadata || !workflow.id || metadata.conversationId !== conversationId) continue;
    if (!best || lastSeq(metadata) > lastSeq(best.metadata))
      best = { workflowId: workflow.id, metadata };
  }
  return best;
}
