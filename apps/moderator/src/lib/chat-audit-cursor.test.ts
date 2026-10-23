import { describe, expect, it } from 'vitest';
import { formatChatAuditCursor, parseChatAuditCursor } from './chat-audit-cursor';

const cursor = {
  at: '2026-10-01 10:00:00.123',
  chatId: 0,
  messageId: 0,
  actorId: 9,
  subjectId: -1,
  type: 'read',
};

describe('chat audit cursor', () => {
  it('round-trips what the page writes into the Older link', () => {
    expect(parseChatAuditCursor(formatChatAuditCursor(cursor))).toEqual(cursor);
  });

  it('ignores a cursor whose ids would fail the query', () => {
    expect(
      parseChatAuditCursor(formatChatAuditCursor({ ...cursor, chatId: 2 ** 31 }))
    ).toBeUndefined();
    expect(
      parseChatAuditCursor(formatChatAuditCursor({ ...cursor, type: 'nope' }))
    ).toBeUndefined();
    expect(parseChatAuditCursor('2026-10-01 10:00:00.123_1_2_3')).toBeUndefined();
  });
});
