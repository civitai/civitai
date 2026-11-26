import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { SignalMessages } from '~/server/common/enums';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import type * as FliptClient from '~/server/flipt/client';

/** Sending as an Invited member joins the chat, as pressing Join would. Ids are invented. */

const h = vi.hoisted(() => ({
  signals: [] as { url: string; body: string }[],
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const original = await importOriginal<typeof FliptClient>();
  return {
    ...original,
    // Masking runs only with the managed list on.
    isFlipt: async (flag: string, ...rest: unknown[]) =>
      flag === original.FLIPT_FEATURE_FLAGS.PROFANITY_MANAGED_LIST ||
      (original.isFlipt as (...a: unknown[]) => Promise<boolean>)(flag, ...rest),
  };
});
vi.mock('~/server/signals/wrapper', () => ({
  withSignals: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('~/server/utils/fetch-timeout', () => ({
  outboundFetch: vi.fn(async (url: string, init: { body: string }) => {
    h.signals.push({ url, body: init.body });
  }),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
  throwOnBlockedMessagePattern: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  getOwnedStickerCosmetics: vi.fn(async () => []),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedUsers: { getCached: vi.fn(async () => []) },
  BlockedByUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: () => ({ increment: async () => 1 }),
}));

const { createMessage } = await import('~/server/services/chat.service');
const { setProfanityListReaderForTests } = await import('~/server/services/profanity-list.service');

// A synthetic token on no real list, enforced as the managed list: this repository is public.
const TOKEN = 'zqvoxmaskedtoken';
const maskingList = {
  read: async () => ({ blocked: [TOKEN], allowed: null, source: 'managed' as const }),
};

const CHAT = 77;
const OWNER = 10;
const AGENT = 20;
const SIGNALS = 'https://signals.test';

type Member = { id: number; userId: number; status: string; joinedAt: Date | null };
type Message = { id: number; userId: number; content: string; createdAt: Date };
let members: Member[];
let messages: Message[];

beforeEach(() => {
  vi.clearAllMocks();
  h.signals.length = 0;
  setEnv({ SIGNALS_ENDPOINT: SIGNALS });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      h.signals.push({ url, body: init.body });
    })
  );
  members = [
    { id: 1, userId: OWNER, status: ChatMemberStatus.Joined, joinedAt: new Date(0) },
    { id: 2, userId: AGENT, status: ChatMemberStatus.Invited, joinedAt: null },
  ];
  messages = [];

  dbMock.dbWrite.chat.findFirst.mockImplementation((async () => ({
    chatMembers: members.map((m) => ({
      ...m,
      isOwner: m.userId === OWNER,
      clearedAt: null,
      // The agent's chat sits in their Requests tab; their reply accepts it.
      filteredAt: m.userId === AGENT ? new Date(0) : null,
      user: { isModerator: false, username: m.userId === AGENT ? 'agent-bot' : 'owner' },
    })),
  })) as never);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ createdAt: new Date(0) } as never);
  dbMock.dbWrite.chatMember.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number; status: string };
    data: Partial<Member>;
  }) => {
    const hit = members.filter(
      (m) => m.id === where.id && (where.status === undefined || m.status === where.status)
    );
    hit.forEach((m) => Object.assign(m, data));
    return { count: hit.length };
  }) as never);
  dbMock.dbWrite.chatMember.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      members.find((m) => m.id === where.id) ?? null) as never
  );
  dbMock.dbWrite.chatMessage.create.mockImplementation((async ({
    data,
  }: {
    data: Omit<Message, 'id' | 'createdAt'> & { createdAt?: Date };
  }) => {
    // A row without an explicit createdAt lands visibly later, so the notice's own stamp is what's tested.
    const createdAt = data.createdAt ?? new Date(Date.now() + 60_000);
    const row = { ...data, id: messages.length + 1, createdAt };
    messages.push(row);
    return { ...row, referenceMessage: null };
  }) as never);
});

const send = (userId: number, content = 'hello') =>
  createMessage({ chatId: CHAT, userId, content, contentType: 'Markdown' } as never);
const agent = () => members.find((m) => m.userId === AGENT)!;

// Viewers get the masked copy from the chat signal and reads; the write response has none.
describe('createMessage response', () => {
  it('carries no masked copy for the sender, even when the list masks the text', async () => {
    setProfanityListReaderForTests(maskingList);
    try {
      const result = await send(OWNER, `a ${TOKEN} b`);
      expect(result).toMatchObject({ content: `a ${TOKEN} b` });
      expect(result).not.toHaveProperty('maskedContent');
    } finally {
      setProfanityListReaderForTests();
    }
  });

  it('keeps the masked copy of a quoted message, which the sender did not write', async () => {
    setProfanityListReaderForTests(maskingList);
    const create = dbMock.dbWrite.chatMessage.create.getMockImplementation()!;
    dbMock.dbWrite.chatMessage.create.mockImplementationOnce((async (args: never) => ({
      ...(await (create as (a: never) => Promise<object>)(args)),
      referenceMessage: { id: 9, userId: AGENT, content: `q ${TOKEN} q` },
    })) as never);
    try {
      const result = (await send(OWNER, 'reply')) as {
        referenceMessage?: { maskedContent?: string | null };
      };
      expect(typeof result.referenceMessage?.maskedContent).toBe('string');
      expect(result.referenceMessage?.maskedContent).not.toContain(TOKEN);
    } finally {
      setProfanityListReaderForTests();
    }
  });
});

describe('createMessage from an Invited member', () => {
  it('joins them, with the join notice ahead of their first message', async () => {
    await send(AGENT, 'first');

    expect(agent().status).toBe(ChatMemberStatus.Joined);
    expect(agent().joinedAt).toBeInstanceOf(Date);
    expect(messages.map((m) => [m.userId, m.content])).toEqual([
      [-1, 'agent-bot joined'],
      [AGENT, 'first'],
    ]);
    expect(messages[0].createdAt).toEqual(agent().joinedAt);
    expect(messages[0].createdAt.getTime()).toBeLessThanOrEqual(messages[1].createdAt.getTime());
  });

  it('does not send the message signal until the notice signal has landed', async () => {
    // Clients append in arrival order, so firing both at once can show the message first.
    let land!: () => void;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce((async (url: string, init: { body: string }) => {
      h.signals.push({ url, body: init.body });
      await new Promise<void>((r) => (land = r));
    }) as never);

    const sending = send(AGENT, 'first');
    await vi.waitFor(() => expect(land).toBeTypeOf('function'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.signals.map((s) => JSON.parse(s.body).content)).not.toContain('first');

    land();
    await sending;
    expect(h.signals.map((s) => JSON.parse(s.body).content)).toContain('first');
  });

  it('adds them to the realtime group and signals the notice before the message', async () => {
    await send(AGENT, 'first');

    const newMessage = `${SIGNALS}/groups/chat:${CHAT}/signals/${SignalMessages.ChatNewMessage}`;
    expect(h.signals.map((s) => s.url)).toEqual([
      `${SIGNALS}/users/${AGENT}/groups`,
      newMessage,
      newMessage,
      `${SIGNALS}/groups/chat:${CHAT}/signals/${SignalMessages.ChatMembersUpdated}`,
      `${SIGNALS}/users/${AGENT}/signals/${SignalMessages.ChatMembersUpdated}`,
    ]);
    const posted = h.signals.slice(1, 3).map((s) => JSON.parse(s.body).content);
    expect(posted).toEqual(['agent-bot joined', 'first']);
  });

  it('posts one notice, not one per message', async () => {
    await send(AGENT, 'first');
    await send(AGENT, 'second');

    expect(messages.filter((m) => m.userId === -1)).toHaveLength(1);
  });

  it('posts no second notice when a concurrent first send joined them after the read', async () => {
    // createMessage reads the member as Invited; the other send's join commits before the write.
    const read = dbMock.dbWrite.chat.findFirst.getMockImplementation()!;
    dbMock.dbWrite.chat.findFirst.mockImplementationOnce((async (...args: never[]) => {
      const snapshot = await read(...args);
      agent().status = ChatMemberStatus.Joined;
      return snapshot;
    }) as never);

    await send(AGENT, 'second');

    expect(messages.map((m) => [m.userId, m.content])).toEqual([[AGENT, 'second']]);
  });

  it('refuses the send when the member was kicked after the read, and does not rejoin them', async () => {
    // createMessage reads the member as Invited; the owner's kick lands before the write.
    const read = dbMock.dbWrite.chat.findFirst.getMockImplementation()!;
    dbMock.dbWrite.chat.findFirst.mockImplementationOnce((async (...args: never[]) => {
      const snapshot = await read(...args);
      agent().status = ChatMemberStatus.Kicked;
      return snapshot;
    }) as never);

    await expect(send(AGENT)).rejects.toThrow('Unable to post in this chat');
    expect(agent().status).toBe(ChatMemberStatus.Kicked);
    expect(messages).toEqual([]);
    // Nor the Requests bookkeeping that runs with the send.
    expect(dbMock.dbWrite.chatMember.update).not.toHaveBeenCalled();
  });
});

describe('createMessage does not join anyone else', () => {
  it('leaves a Joined sender alone, and the Invited recipient Invited', async () => {
    await send(OWNER);

    expect(dbMock.dbWrite.chatMember.updateMany).not.toHaveBeenCalled();
    expect(messages.map((m) => m.userId)).toEqual([OWNER]);
    // Being messaged is not joining.
    expect(agent().status).toBe(ChatMemberStatus.Invited);
    // Nothing to roll back, so no transaction on the common path.
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it.each([ChatMemberStatus.Left, ChatMemberStatus.Kicked, ChatMemberStatus.Ignored])(
    'still refuses a %s member and leaves them %s',
    async (status) => {
      agent().status = status;

      await expect(send(AGENT)).rejects.toThrow('Unable to post in this chat');
      expect(agent().status).toBe(status);
      expect(messages).toEqual([]);
    }
  );
});
