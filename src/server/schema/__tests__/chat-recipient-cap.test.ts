import { describe, expect, it } from 'vitest';
import { addUsersInput, createChatInput } from '~/server/schema/chat.schema';
import { MAX_CHAT_MEMBERS } from '~/shared/utils/chat';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// The cap sits on the input so an oversized list is refused before any per-recipient lookup runs.
describe('chat recipient lists are capped at the group size', () => {
  it('starts a chat with a full group and refuses one more', () => {
    expect(createChatInput.safeParse({ userIds: ids(MAX_CHAT_MEMBERS) }).success).toBe(true);
    expect(createChatInput.safeParse({ userIds: ids(MAX_CHAT_MEMBERS + 1) }).success).toBe(false);
  });

  it('adds a full group and refuses one more', () => {
    expect(addUsersInput.safeParse({ chatId: 1, userIds: ids(MAX_CHAT_MEMBERS) }).success).toBe(
      true
    );
    expect(addUsersInput.safeParse({ chatId: 1, userIds: ids(MAX_CHAT_MEMBERS + 1) }).success).toBe(
      false
    );
  });
});
