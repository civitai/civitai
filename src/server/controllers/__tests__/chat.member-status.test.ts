import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SignalsWrapper from '~/server/signals/wrapper';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';

vi.mock('~/server/signals/wrapper', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalsWrapper>()),
  withSignals: async () => undefined,
}));

const { modifyUserHandler } = await import('../chat.controller');

const CHAT = 3;
const OWNER = 1;
const MEMBER = 2;
const MEMBER_ROW = 20;

type Row = {
  id: number;
  userId: number;
  status: ChatMemberStatus;
  isOwner: boolean;
  joinedAt: Date | null;
  filteredAt?: Date | null;
};
let rows: Row[];
let notices: string[];
const member = () => rows.find((r) => r.id === MEMBER_ROW)!;

const setStatus = (actor: number, status: ChatMemberStatus) =>
  modifyUserHandler({
    input: { chatMemberId: MEMBER_ROW, status } as never,
    ctx: { user: { id: actor, isModerator: false } } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  notices = [];
  rows = [
    {
      id: 10,
      userId: OWNER,
      status: ChatMemberStatus.Joined,
      isOwner: true,
      joinedAt: new Date(0),
    },
    {
      id: MEMBER_ROW,
      userId: MEMBER,
      status: ChatMemberStatus.Joined,
      isOwner: false,
      joinedAt: null,
    },
  ];
  dbMock.dbWrite.chatMember.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const row = rows.find((r) => r.id === where.id);
    if (!row) return null;
    return {
      ...row,
      user: { username: 'member', isModerator: false },
      chat: {
        id: CHAT,
        ownerId: OWNER,
        isGroup: true,
        owner: { isModerator: false },
        chatMembers: rows.map((r) => ({ ...r, createdAt: new Date(0) })),
      },
    };
  }) as never);
  dbMock.dbWrite.chatMember.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number; status?: ChatMemberStatus };
    data: Partial<Row>;
  }) => {
    const hit = rows.filter(
      (r) => r.id === where.id && (where.status === undefined || r.status === where.status)
    );
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  }) as never);
  dbMock.dbWrite.chatMember.findUniqueOrThrow.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ ...rows.find((r) => r.id === where.id)! })) as never);
  dbMock.dbWrite.chat.findFirst.mockResolvedValue({ chatMembers: [] } as never);
  dbMock.dbWrite.chatMessage.create.mockImplementation((async ({
    data,
  }: {
    data: { content: string };
  }) => {
    notices.push(data.content);
    return { id: notices.length, ...data, referenceMessage: null };
  }) as never);
});

describe('modifyUser: a member changing their own status', () => {
  it('cannot undo a kick', async () => {
    member().status = ChatMemberStatus.Kicked;

    await expect(setStatus(MEMBER, ChatMemberStatus.Joined)).rejects.toThrow(
      'Cannot change from Kicked to Joined'
    );
    expect(member().status).toBe(ChatMemberStatus.Kicked);
    expect(notices).toEqual([]);
  });

  it.each([ChatMemberStatus.Joined, ChatMemberStatus.Left, ChatMemberStatus.Kicked])(
    'cannot make themselves Invited from %s',
    async (from) => {
      member().status = from;

      await expect(setStatus(MEMBER, ChatMemberStatus.Invited)).rejects.toThrow('Cannot change');
      expect(member().status).toBe(from);
    }
  );

  // Every change the chat UI offers: Join, Decline, Leave, Archive, Rejoin, Unarchive.
  it.each([
    [ChatMemberStatus.Invited, ChatMemberStatus.Joined],
    [ChatMemberStatus.Invited, ChatMemberStatus.Ignored],
    [ChatMemberStatus.Joined, ChatMemberStatus.Left],
    [ChatMemberStatus.Joined, ChatMemberStatus.Ignored],
    [ChatMemberStatus.Left, ChatMemberStatus.Joined],
    [ChatMemberStatus.Ignored, ChatMemberStatus.Joined],
  ])('can go from %s to %s', async (from, to) => {
    member().status = from;

    await setStatus(MEMBER, to);

    expect(member().status).toBe(to);
  });

  it('joins through the shared join: one notice, joinedAt set', async () => {
    member().status = ChatMemberStatus.Invited;
    // A request sitting in the Requests tab: joining is accepting it.
    member().filteredAt = new Date(0);

    await setStatus(MEMBER, ChatMemberStatus.Joined);

    expect(notices).toEqual(['member joined']);
    expect(member().joinedAt).toBeInstanceOf(Date);
    expect(member().filteredAt).toBeNull();
  });

  it('does not overwrite a kick that landed after the read', async () => {
    member().status = ChatMemberStatus.Invited;
    const read = dbMock.dbWrite.chatMember.findFirst.getMockImplementation()!;
    dbMock.dbWrite.chatMember.findFirst.mockImplementationOnce((async (...args: never[]) => {
      const snapshot = await read(...args);
      member().status = ChatMemberStatus.Kicked;
      return snapshot;
    }) as never);

    await expect(setStatus(MEMBER, ChatMemberStatus.Ignored)).rejects.toThrow(
      'This membership changed'
    );
    expect(member().status).toBe(ChatMemberStatus.Kicked);
  });

  it('does not report a join as done when a kick landed after the read', async () => {
    member().status = ChatMemberStatus.Left;
    const read = dbMock.dbWrite.chatMember.findFirst.getMockImplementation()!;
    dbMock.dbWrite.chatMember.findFirst.mockImplementationOnce((async (...args: never[]) => {
      const snapshot = await read(...args);
      member().status = ChatMemberStatus.Kicked;
      return snapshot;
    }) as never);

    await expect(setStatus(MEMBER, ChatMemberStatus.Joined)).rejects.toThrow(
      'This membership changed'
    );
    expect(member().status).toBe(ChatMemberStatus.Kicked);
    expect(notices).toEqual([]);
  });

  it('refuses an unknown membership rather than creating one', async () => {
    rows = rows.filter((r) => r.id !== MEMBER_ROW);

    await expect(setStatus(MEMBER, ChatMemberStatus.Joined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(rows).toHaveLength(1);
  });
});

describe('modifyUser: asking for the status a member already has', () => {
  it('is a no-op, not an error, so a stale tab or a double click is harmless', async () => {
    await expect(setStatus(MEMBER, ChatMemberStatus.Joined)).resolves.toMatchObject({
      status: ChatMemberStatus.Joined,
    });
    expect(dbMock.dbWrite.chatMember.updateMany).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('does not restamp kickedAt when an owner kicks an already-kicked member', async () => {
    // kickedAt is where a kicked member's reads stop; moving it reopens what came after.
    member().status = ChatMemberStatus.Kicked;

    await setStatus(OWNER, ChatMemberStatus.Kicked);

    expect(dbMock.dbWrite.chatMember.updateMany).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('succeeds when a concurrent request joined them after the read', async () => {
    member().status = ChatMemberStatus.Left;
    const read = dbMock.dbWrite.chatMember.findFirst.getMockImplementation()!;
    dbMock.dbWrite.chatMember.findFirst.mockImplementationOnce((async (...args: never[]) => {
      const snapshot = await read(...args);
      member().status = ChatMemberStatus.Joined;
      return snapshot;
    }) as never);

    await expect(setStatus(MEMBER, ChatMemberStatus.Joined)).resolves.toMatchObject({
      status: ChatMemberStatus.Joined,
    });
    expect(notices).toEqual([]);
  });
});

describe('modifyUser: the owner', () => {
  it('can still kick a member', async () => {
    await setStatus(OWNER, ChatMemberStatus.Kicked);

    expect(member().status).toBe(ChatMemberStatus.Kicked);
    expect(notices).toEqual(['member was kicked']);
  });
});
