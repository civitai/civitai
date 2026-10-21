import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
const getChatHold = vi.fn();
vi.mock('$lib/server/csam-holds.queries', () => ({ getChatHold }));
const getChatWindow = vi.fn();
const getJudgedMessages = vi.fn();
vi.mock('$lib/server/chat-audit.service', () => ({ getChatWindow, getJudgedMessages }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { GET } = await import('../+server');

const call = (holdId: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  GET({ params: { holdId }, locals: { user: { id: 1 }, grants } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
  getChatHold.mockResolvedValue({ chatId: 5, messageIds: [11], senderId: 3 });
  getChatWindow.mockResolvedValue({
    omitted: 4,
    rows: [
      {
        id: 11,
        createdAt: new Date('2026-10-01T10:00:00Z'),
        userId: 3,
        username: 'sender',
        bannedAt: new Date('2026-10-02T00:00:00Z'),
        content: 'text',
        editedAt: null,
        deletedAt: new Date('2026-10-01T11:00:00Z'),
      },
    ],
  });
});

describe('/api/csam-hold-chat', () => {
  it('serves the conversation around the judged messages', async () => {
    const body = await (await call('7')).json();
    expect(getChatWindow).toHaveBeenCalledWith(5, [11]);
    expect(body).toEqual({
      chatId: 5,
      judgedIds: [11],
      senderId: 3,
      omitted: 4,
      fullConversation: true,
      messages: [
        {
          id: 11,
          createdAt: '2026-10-01T10:00:00.000Z',
          userId: 3,
          username: 'sender',
          bannedAt: '2026-10-02T00:00:00.000Z',
          content: 'text',
          editedAt: null,
          deletedAt: '2026-10-01T11:00:00.000Z',
        },
      ],
    });
  });

  it('gives a moderator without Chat Audit access only the sender judged messages', async () => {
    canAccess.mockImplementation((_user, path) => path !== '/retool/chat-audit');
    getJudgedMessages.mockResolvedValue([
      {
        id: 11,
        createdAt: new Date('2026-10-01T10:00:00Z'),
        userId: 3,
        username: 'sender',
        bannedAt: new Date('2026-10-02T00:00:00Z'),
        content: 'text',
        editedAt: null,
        deletedAt: null,
      },
    ]);
    const body = await (await call('7')).json();
    expect(getChatWindow).not.toHaveBeenCalled();
    expect(getJudgedMessages).toHaveBeenCalledWith(5, [11], 3);
    expect(body.fullConversation).toBe(false);
    expect(body.omitted).toBe(0);
    expect(body.messages.map((m: { userId: number }) => m.userId)).toEqual([3]);
  });

  it('flags the full conversation for a moderator with Chat Audit access', async () => {
    const body = await (await call('7')).json();
    expect(getJudgedMessages).not.toHaveBeenCalled();
    expect(body.fullConversation).toBe(true);
  });

  it('refuses a moderator without the csam filing grant before reading anything', async () => {
    await expect(call('7', {})).rejects.toMatchObject({ status: 403 });
    expect(getChatHold).not.toHaveBeenCalled();
  });

  it('refuses a moderator who cannot open the page', async () => {
    canAccess.mockImplementation(() => false);
    await expect(call('7')).rejects.toMatchObject({ status: 403 });
    expect(getChatHold).not.toHaveBeenCalled();
  });

  it('rejects a hold id that is not a number', async () => {
    await expect(call('abc')).rejects.toMatchObject({ status: 400 });
  });

  it('is a 404 when the hold is not a chat hold', async () => {
    getChatHold.mockResolvedValue(null);
    await expect(call('7')).rejects.toMatchObject({ status: 404 });
    expect(getChatWindow).not.toHaveBeenCalled();
  });
});
