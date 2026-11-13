import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StoredConversationMetadata } from '@civitai/components-chat/core';

import type { ConversationStore } from '../interfaces';

/** A conversation store in files, so a head outlives the process that wrote it (the crash test). One process at a time. */
export class FileConversationStore implements ConversationStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(userId: string, conversationId: string): string {
    return join(
      this.dir,
      `${encodeURIComponent(userId)}--${encodeURIComponent(conversationId)}.json`
    );
  }

  async load(userId: string, conversationId: string): Promise<StoredConversationMetadata | null> {
    try {
      return JSON.parse(
        readFileSync(this.path(userId, conversationId), 'utf8')
      ) as StoredConversationMetadata;
    } catch {
      return null;
    }
  }

  async update(
    userId: string,
    conversationId: string,
    change: (head: StoredConversationMetadata | null) => StoredConversationMetadata | null
  ): Promise<StoredConversationMetadata | null> {
    const current = await this.load(userId, conversationId);
    const next = change(current);
    if (!next) return current;
    const path = this.path(userId, conversationId);
    writeFileSync(`${path}.tmp`, JSON.stringify(next));
    renameSync(`${path}.tmp`, path);
    return next;
  }
}
