import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';

const h = vi.hoisted(() => ({ signals: 0 }));
vi.mock('~/server/signals/wrapper', () => ({
  withSignals: async () => {
    h.signals += 1;
  },
}));

const { getMessageByIdHandler, getChatsForUserHandler, isTypingHandler, modifyUserHandler } =
  await import('../chat.controller');

const ME = 7;
const OTHER = 8;
const EXIT = new Date('2026-11-01T00:00:00Z');
const BEFORE = new Date('2026-10-31T00:00:00Z');
const AFTER = new Date('2026-11-02T00:00:00Z');
const ctx = { user: { id: ME, muted: false } } as never;

type Me = {
  status: ChatMemberStatus;
  leftAt?: Date | null;
  kickedAt?: Date | null;
  clearedAt?: Date | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.signals = 0;
  setEnv({ SIGNALS_ENDPOINT: 'https://signals.test' });
});

describe('getMessageById reads only inside the member window', () => {
  const byId = (me: Me, createdAt: Date) => {
    dbMock.dbWrite.chatMessage.findFirst.mockResolvedValue({
      createdAt,
      content: 'hello',
      contentType: 'Markdown',
      user: { id: OTHER },
      chat: {
        chatMembers: [
          { userId: ME, clearedAt: null, leftAt: null, kickedAt: null, ...me },
          { userId: OTHER, status: ChatMemberStatus.Joined },
        ],
      },
    } as never);
    return getMessageByIdHandler({ input: { messageId: 1 }, ctx });
  };

  it.each([
    [{ status: ChatMemberStatus.Kicked, kickedAt: EXIT }],
    [{ status: ChatMemberStatus.Left, leftAt: EXIT }],
  ])('hides a message sent after %o', async (me) => {
    await expect(byId(me, AFTER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still shows a message from before they left', async () => {
    await expect(
      byId({ status: ChatMemberStatus.Left, leftAt: EXIT }, BEFORE)
    ).resolves.toMatchObject({
      content: 'hello',
    });
  });

  it('shows a Joined member anything', async () => {
    await expect(byId({ status: ChatMemberStatus.Joined }, AFTER)).resolves.toMatchObject({
      content: 'hello',
    });
  });
});

describe('the chat list preview', () => {
  const list = async (me: Me) => {
    dbMock.dbWrite.chat.findMany.mockResolvedValue([
      {
        id: 3,
        messages: [{ createdAt: AFTER, content: 'said after', userId: OTHER }],
        chatMembers: [
          { userId: ME, status: me.status, clearedAt: me.clearedAt ?? null },
          { userId: OTHER, status: ChatMemberStatus.Joined, clearedAt: null },
        ],
      },
    ] as never);
    dbMock.dbRead.chatMember.findMany.mockResolvedValue([
      { chatId: 3, leftAt: me.leftAt ?? null, kickedAt: me.kickedAt ?? null },
    ] as never);
    const [chat] = (await getChatsForUserHandler({ ctx })) as { messages: unknown[] }[];
    return chat;
  };

  it('keeps the chat but withholds a message sent after the kick', async () => {
    const chat = await list({ status: ChatMemberStatus.Kicked, kickedAt: EXIT });
    expect(chat).toBeDefined();
    expect(chat.messages).toEqual([]);
  });

  it('keeps a chat they cleared and then left in the list', async () => {
    // Cleared before leaving, and the chat came back with history: the exit
    // empties the preview, not the list entry.
    const chat = await list({
      status: ChatMemberStatus.Left,
      leftAt: EXIT,
      clearedAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(chat).toBeDefined();
    expect(chat.messages).toEqual([]);
  });

  it('shows a Joined member the latest message', async () => {
    expect((await list({ status: ChatMemberStatus.Joined })).messages).toHaveLength(1);
  });

  it('keeps an archived (Ignored) conversation its preview', async () => {
    expect((await list({ status: ChatMemberStatus.Ignored })).messages).toHaveLength(1);
  });
});

describe('kicking a member who already left', () => {
  it('keeps their cutoff at when they left', async () => {
    dbMock.dbWrite.chatMember.findFirst.mockResolvedValue({
      id: 20,
      userId: OTHER,
      status: ChatMemberStatus.Left,
      leftAt: EXIT,
      isOwner: false,
      user: { username: 'other', isModerator: false },
      chat: { id: 3, ownerId: ME, isGroup: true, owner: { isModerator: false }, chatMembers: [] },
    } as never);
    dbMock.dbWrite.chatMember.updateMany.mockResolvedValue({ count: 1 } as never);
    dbMock.dbWrite.chatMember.findUniqueOrThrow.mockResolvedValue({ id: 20 } as never);
    dbMock.dbWrite.chat.findFirst.mockResolvedValue({ chatMembers: [] } as never);

    await modifyUserHandler({
      input: { chatMemberId: 20, status: ChatMemberStatus.Kicked } as never,
      ctx: { user: { id: ME, isModerator: false } } as never,
    });

    expect(dbMock.dbWrite.chatMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kickedAt: EXIT }) })
    );
  });
});

describe('isTyping', () => {
  const typing = (status: ChatMemberStatus) => {
    dbMock.dbWrite.chat.findFirst.mockResolvedValue({
      chatMembers: [
        { userId: ME, isOwner: false, status, user: { username: 'me', isModerator: false } },
      ],
    } as never);
    return isTypingHandler({ input: { chatId: 3, userId: ME, isTyping: true }, ctx });
  };

  it.each([ChatMemberStatus.Kicked, ChatMemberStatus.Left, ChatMemberStatus.Ignored])(
    'sends nothing for a %s member',
    async (status) => {
      await typing(status);
      expect(h.signals).toBe(0);
    }
  );

  it.each([ChatMemberStatus.Joined, ChatMemberStatus.Invited])(
    'signals for a %s member',
    async (status) => {
      await typing(status);
      expect(h.signals).toBe(1);
    }
  );
});
