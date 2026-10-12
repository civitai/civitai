import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CHAT_WINDOW_MAX_CHARS,
  CHAT_WINDOW_MAX_MESSAGES,
  CHAT_WINDOW_MIN_CHARS,
  CHAT_WINDOW_SCAN_ROWS,
  loadChatWindows,
} from '~/server/services/text-scan/profiles/chat-message.profile';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';

const NEWEST = {
  id: 30,
  chatId: 4,
  userId: 5,
  createdAt: new Date('2026-09-24T12:00:00Z'),
  editedAt: null,
  contentType: 'Markdown',
  deletedAt: null,
};
const findUnique = dbMock.dbWrite.chatMessage.findUnique;
const findFirst = dbMock.dbWrite.chatMessage.findFirst;
const findMany = dbMock.dbWrite.chatMessage.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(NEWEST);
  findFirst.mockResolvedValue(null);
  findMany.mockResolvedValue([
    { id: 30, content: 'send the fee' },
    { id: 21, content: 'hello' },
  ]);
  dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: 5, isModerator: false }]);
});

describe('loadChatWindows', () => {
  it('builds the window from the sender, newest first, on the primary', async () => {
    const subject = (await loadChatWindows([30])).get(30)!;
    expect(subject).toEqual({
      fields: [{ heading: 'Messages, newest first', text: 'send the fee\nhello' }],
      declared: {},
      userId: 5,
      meta: {
        chatId: 4,
        senderId: 5,
        messageIds: [30, 21],
        contentAt: NEWEST.createdAt.toISOString(),
        subjectUserId: 5,
      },
    });
    const { where, orderBy, take } = findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      chatId: 4,
      userId: 5,
      id: { lte: 30 },
      deletedAt: null,
      contentType: 'Markdown',
    });
    expect(where.createdAt.gte).toEqual(new Date('2026-09-23T12:00:00Z'));
    expect(orderBy).toEqual({ id: 'desc' });
    expect(take).toBe(CHAT_WINDOW_MAX_MESSAGES);
    expect(dbMock.dbRead.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('bounds the backward walk to the chat’s last rows before the newest message', async () => {
    findFirst.mockResolvedValue({ id: 7 });
    await loadChatWindows([30]);

    expect(findFirst).toHaveBeenCalledWith({
      where: { chatId: 4, id: { lte: 30 }, deletedAt: null },
      orderBy: { id: 'desc' },
      skip: CHAT_WINDOW_SCAN_ROWS - 1,
      select: { id: true },
    });
    expect(findMany.mock.calls[0][0].where.id).toEqual({ lte: 30, gte: 7 });
  });

  it('reads the whole chat when it is shorter than the bound', async () => {
    await loadChatWindows([30]);
    expect(findMany.mock.calls[0][0].where.id).toEqual({ lte: 30 });
  });

  it('dates an edited window by the edit', async () => {
    const editedAt = new Date('2026-09-24T13:00:00Z');
    findUnique.mockResolvedValue({ ...NEWEST, editedAt });
    expect((await loadChatWindows([30])).get(30)!.meta).toMatchObject({
      contentAt: editedAt.toISOString(),
    });
  });

  it('never carries another participant’s words or id', async () => {
    const all = [
      { id: 30, userId: 5, content: 'send the fee' },
      { id: 29, userId: 6, content: 'my card number is 4111' },
      { id: 21, userId: 5, content: 'hello' },
    ];
    findMany.mockImplementation(
      async ({ where }: { where: { userId: number; id: { lte: number } } }) =>
        all
          .filter((m) => m.userId === where.userId && m.id <= where.id.lte)
          .sort((a, b) => b.id - a.id)
    );
    const subject = (await loadChatWindows([30])).get(30)!;
    expect(subject.fields[0].text).not.toContain('4111');
    expect(subject.userId).toBe(5);
    expect(subject.meta).toMatchObject({ senderId: 5, messageIds: [30, 21] });
  });

  it.each([
    ['missing', null],
    ['a system message', { ...NEWEST, userId: -1 }],
    ['a non-Markdown message', { ...NEWEST, contentType: 'Image' }],
    ['a deleted message', { ...NEWEST, deletedAt: new Date() }],
  ])('skips %s', async (_name, row) => {
    findUnique.mockResolvedValue(row);
    expect((await loadChatWindows([30])).has(30)).toBe(false);
  });

  it('skips a sender outside the scam window without reading the window', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([]);
    expect((await loadChatWindows([30])).has(30)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps the newest message when older ones exceed the budget', async () => {
    findMany.mockResolvedValue([
      { id: 30, content: 'NEWEST' },
      { id: 29, content: 'x'.repeat(CHAT_WINDOW_MAX_CHARS) },
    ]);
    const subject = (await loadChatWindows([30])).get(30)!;
    expect(subject.fields[0].text).toBe('NEWEST');
    expect(subject.meta).toMatchObject({ messageIds: [30] });
  });

  it('truncates a single oversized newest message to the budget', async () => {
    findMany.mockResolvedValue([{ id: 30, content: 'y'.repeat(CHAT_WINDOW_MAX_CHARS + 50) }]);
    expect((await loadChatWindows([30])).get(30)!.fields[0].text).toHaveLength(
      CHAT_WINDOW_MAX_CHARS
    );
  });

  it('is registered as the ChatMessage scam profile', () => {
    expect(getTextScanProfile('ChatMessage')).toMatchObject({
      labels: ['scam'],
      minChars: CHAT_WINDOW_MIN_CHARS,
    });
  });
});
