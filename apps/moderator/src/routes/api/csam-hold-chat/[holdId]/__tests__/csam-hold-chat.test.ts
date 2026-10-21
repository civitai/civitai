import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
const getChatHold = vi.fn();
vi.mock('$lib/server/csam-holds.queries', () => ({ getChatHold }));
const getChatWindow = vi.fn();
vi.mock('$lib/server/chat-audit.service', () => ({ getChatWindow }));
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
      messages: [
        {
          id: 11,
          createdAt: '2026-10-01T10:00:00.000Z',
          userId: 3,
          username: 'sender',
          content: 'text',
          edited: false,
          deleted: true,
        },
      ],
    });
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
