import type { StoredConversationMetadata } from '@civitai/components-chat/core';

import type { ConversationStore } from './interfaces';

/** A conversation store in this process's memory, for tests. Lost on exit. */
export class MemoryConversationStore implements ConversationStore {
  readonly heads = new Map<string, StoredConversationMetadata>();

  async load(userId: string, conversationId: string): Promise<StoredConversationMetadata | null> {
    const head = this.heads.get(key(userId, conversationId));
    return head ? structuredClone(head) : null;
  }

  async update(
    userId: string,
    conversationId: string,
    change: (head: StoredConversationMetadata | null) => StoredConversationMetadata | null
  ): Promise<StoredConversationMetadata | null> {
    const id = key(userId, conversationId);
    const current = this.heads.get(id);
    const next = change(current ? structuredClone(current) : null);
    if (next) this.heads.set(id, structuredClone(next));
    return next ?? (current ? structuredClone(current) : null);
  }
}

function key(userId: string, conversationId: string): string {
  return `${userId}\u0000${conversationId}`;
}
