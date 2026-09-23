import { describe, expect, it } from 'vitest';
import { filterBlockedChatMessages } from '~/shared/utils/chat';

/**
 * Chat bug (868kxvagf): blocking a member hid their content everywhere else on
 * the site but not their messages inside a group conversation.
 */

const msg = (id: number, userId: number) => ({ id, userId, content: `m${id}` });

describe('filterBlockedChatMessages', () => {
  it('drops messages authored by a blocked user', () => {
    const messages = [msg(1, 10), msg(2, 20), msg(3, 10), msg(4, 30)];
    const kept = filterBlockedChatMessages(messages, [10]);
    expect(kept.map((m) => m.id)).toEqual([2, 4]);
  });

  it('drops messages from every blocked user', () => {
    const messages = [msg(1, 10), msg(2, 20), msg(3, 30)];
    const kept = filterBlockedChatMessages(messages, [10, 30]);
    expect(kept.map((m) => m.id)).toEqual([2]);
  });

  it('returns the original array when nobody is blocked', () => {
    const messages = [msg(1, 10), msg(2, 20)];
    expect(filterBlockedChatMessages(messages, [])).toBe(messages);
  });
});
