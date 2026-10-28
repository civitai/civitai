import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ChatService from '~/server/services/chat.service';
import type * as NotificationService from '~/server/services/notification.service';
import { resolveChatIdentity } from '~/server/utils/chat-group';

/**
 * Messaging as the shared Civitai Moderation account, against a real Postgres for the claim, cap,
 * inbox and audit queries. Chat creation and posting are the chat service's own (tested there);
 * here they write the rows those queries read. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  upsertChat: vi.fn(),
  createMessage: vi.fn(),
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/chat.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatService>()),
  upsertChat: h.upsertChat,
  createMessage: h.createMessage,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: h.createNotification,
}));

const {
  sendAsCivitai,
  sendAsCivitaiOnce,
  claimThread,
  releaseThread,
  getInbox,
  getThread,
  getMessageAuthors,
} = await import('~/server/services/message-as-civitai.service');

const CIVITAI = 900;
const MOD_A = 11;
const MOD_B = 12;
const USER = 501;
const OTHER_USER = 502;
const BANNED = 503;

let db: PGlite;
let nextId = 1;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Chat" (id int PRIMARY KEY, hash text UNIQUE, "isGroup" boolean NOT NULL DEFAULT false);
    CREATE TABLE "ChatMember" (
      id serial PRIMARY KEY, "chatId" int NOT NULL, "userId" int NOT NULL,
      status text NOT NULL DEFAULT 'Joined'
    );
    CREATE TABLE "ChatMessage" (
      id int PRIMARY KEY, "chatId" int NOT NULL, "userId" int NOT NULL, content text NOT NULL,
      "contentType" text NOT NULL DEFAULT 'Markdown',
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "deletedAt" timestamp(3)
    );
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      CHECK ("entityType" <> 'report' OR "entityId" < 1000)
    );
    CREATE TABLE "ModThreadClaim" (
      "chatId" int PRIMARY KEY, "moderatorId" int NOT NULL,
      "claimedAt" timestamp(3) NOT NULL DEFAULT now(), "expiresAt" timestamp(3) NOT NULL
    );
    INSERT INTO "User" (id, username) VALUES
      (${CIVITAI}, 'CivitaiModeration'), (${MOD_A}, 'mod-a'), (${MOD_B}, 'mod-b'),
      (${USER}, 'someone'), (${OTHER_USER}, 'someone-else');
  `);
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

const hashFor = (userId: number) =>
  resolveChatIdentity({ userIds: [CIVITAI, userId], isGroup: false }).hash;

async function postAs(chatId: number, userId: number, content: string, minutesAgo = 0) {
  const id = nextId++;
  await db.query(
    `INSERT INTO "ChatMessage" (id, "chatId", "userId", content, "createdAt")
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))`,
    [id, chatId, userId, content, minutesAgo]
  );
  return { id };
}

const redisStore = new Map<string, string>();

beforeEach(async () => {
  vi.clearAllMocks();
  nextId = 1;
  redisStore.clear();
  setEnv({ CIVITAI_MODERATION_USER_ID: CIVITAI, MESSAGE_AS_CIVITAI_DAILY_CAP: 3 });
  await db.exec(`
    DELETE FROM "Chat"; DELETE FROM "ChatMember"; DELETE FROM "ChatMessage";
    DELETE FROM "ModActivity"; DELETE FROM "ModThreadClaim";
  `);

  dbMock.dbWrite.user.findFirst.mockImplementation((async ({ where }: { where: { id: number } }) =>
    where.id === BANNED
      ? { id: BANNED, bannedAt: new Date() }
      : [USER, OTHER_USER].includes(where.id)
      ? { id: where.id, bannedAt: null }
      : where.id === MOD_A
      ? { id: MOD_A, username: 'mod-a' }
      : null) as never);
  dbMock.dbWrite.chatMember.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { chatId: number; userId: number };
  }) => {
    const { rows } = await db.query(
      `SELECT status FROM "ChatMember" WHERE "chatId" = $1 AND "userId" = $2`,
      [where.chatId, where.userId]
    );
    return rows[0] ?? null;
  }) as never);
  dbMock.dbWrite.chat.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { hash: string };
  }) => {
    const { rows } = await db.query(`SELECT id FROM "Chat" WHERE hash = $1`, [where.hash]);
    return rows[0] ?? null;
  }) as never);

  h.upsertChat.mockImplementation(
    async ({ userIds, userId }: { userIds: number[]; userId: number }) => {
      const id = 100 + userIds[0];
      await db.query(`INSERT INTO "Chat" (id, hash) VALUES ($1, $2)`, [id, hashFor(userIds[0])]);
      await db.query(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES ($1, $2), ($1, $3)`, [
        id,
        userId,
        userIds[0],
      ]);
      return { id };
    }
  );
  h.createMessage.mockImplementation(
    async ({ chatId, userId, content }: { chatId: number; userId: number; content: string }) =>
      postAs(chatId, userId, content)
  );

  redisMock.sysRedis.set.mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean }
  ) => {
    if (opts?.NX && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.get.mockImplementation(
    (async (key: string) => redisStore.get(key) ?? null) as never
  );
  redisMock.sysRedis.eval.mockImplementation((async (
    _script: string,
    { keys, arguments: args }: { keys: string[]; arguments: string[] }
  ) => {
    if (redisStore.get(keys[0]) !== args[0]) return 0;
    redisStore.delete(keys[0]);
    return 1;
  }) as never);
  redisMock.sysRedis.del.mockImplementation((async (key: string) =>
    Number(redisStore.delete(key))) as never);
});

describe('sendAsCivitai', () => {
  it('sends as the shared account with moderator standing, and records the acting moderator', async () => {
    const { chatId, messageId } = await sendAsCivitai({
      actorId: MOD_A,
      userId: USER,
      message: 'hi',
    });

    // Moderator standing is what skips the recipient's DM policy and joins them to the thread.
    expect(h.upsertChat).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CIVITAI, userIds: [USER], isModerator: true })
    );
    expect(h.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, userId: CIVITAI, isModerator: true })
    );
    const { rows } = await db.query(`SELECT "userId", "entityType", "entityId" FROM "ModActivity"`);
    expect(rows).toEqual([{ userId: MOD_A, entityType: 'chatMessage', entityId: messageId }]);
    expect(h.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        details: expect.objectContaining({ url: `/?chat=${chatId}` }),
      })
    );
  });

  it('links the message to the report it was sent from', async () => {
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'hi', context: { reportId: 77 } });
    const { rows } = await db.query(
      `SELECT "userId", "entityId" FROM "ModActivity" WHERE "entityType" = 'report'`
    );
    expect(rows).toEqual([{ userId: MOD_A, entityId: 77 }]);
  });

  it('reuses the one thread per user', async () => {
    const first = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'one' });
    const second = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'two' });
    expect(second.chatId).toBe(first.chatId);
    expect(h.upsertChat).toHaveBeenCalledTimes(1);
  });

  it('refuses when the shared account is not configured', async () => {
    setEnv({ CIVITAI_MODERATION_USER_ID: '' });
    await expect(sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'x' })).rejects.toThrow(
      /not configured/
    );
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it('refuses a banned user, who answers through appeals instead', async () => {
    await expect(sendAsCivitai({ actorId: MOD_A, userId: BANNED, message: 'x' })).rejects.toThrow(
      /banned/
    );
    expect(h.upsertChat).not.toHaveBeenCalled();
  });

  it('refuses while another moderator holds the claim, and allows the holder', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'one' });
    await expect(sendAsCivitai({ actorId: MOD_B, userId: USER, message: 'two' })).rejects.toThrow(
      /mod-a is answering this thread for the next 30 min/
    );
    await expect(sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'two' })).resolves.toEqual(
      expect.objectContaining({ chatId })
    );
  });

  it('caps unanswered messages per user, and a reply from the user resets the count', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '1' });
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '2' });
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '3' });
    await expect(sendAsCivitai({ actorId: MOD_A, userId: USER, message: '4' })).rejects.toThrow(
      /unanswered/
    );

    await postAs(chatId, USER, 'a reply');
    await expect(
      sendAsCivitai({ actorId: MOD_A, userId: USER, message: '4' })
    ).resolves.toBeDefined();
  });

  it('counts only the last 24 hours toward the cap', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '1' });
    await postAs(chatId, CIVITAI, 'old', 25 * 60);
    await postAs(chatId, CIVITAI, 'old', 25 * 60);
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '2' });
    await expect(
      sendAsCivitai({ actorId: MOD_A, userId: USER, message: '3' })
    ).resolves.toBeDefined();
  });
});

describe('sendAsCivitai refusals that must not take the thread', () => {
  it.each([
    ['Invited', true],
    ['Kicked', false],
    ['Ignored', false],
    [null, false],
  ] as const)('a recipient whose membership is %s can be messaged: %s', async (status, allowed) => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'one' });
    if (status === null)
      await db.query(`DELETE FROM "ChatMember" WHERE "chatId" = $1 AND "userId" = $2`, [
        chatId,
        USER,
      ]);
    else
      await db.query(`UPDATE "ChatMember" SET status = $3 WHERE "chatId" = $1 AND "userId" = $2`, [
        chatId,
        USER,
        status,
      ]);
    const second = sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'two' });
    if (allowed) await expect(second).resolves.toBeDefined();
    else await expect(second).rejects.toThrow(/no longer in/);
  });

  it('refuses a user who has left the thread', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'one' });
    await db.query(
      `UPDATE "ChatMember" SET status = 'Left' WHERE "chatId" = $1 AND "userId" = $2`,
      [chatId, USER]
    );
    await expect(sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'two' })).rejects.toThrow(
      /no longer in/
    );
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses at the cap without claiming the thread', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '1' });
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '2' });
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: '3' });
    await releaseThread({ chatId, moderatorId: MOD_A });
    await expect(sendAsCivitai({ actorId: MOD_B, userId: USER, message: '4' })).rejects.toThrow(
      /unanswered/
    );
    const { rows } = await db.query(`SELECT 1 FROM "ModThreadClaim" WHERE "chatId" = $1`, [chatId]);
    expect(rows).toEqual([]);
  });

  it('refuses while another send to the same user is in flight, and frees the lock after', async () => {
    redisStore.set(`message-as-civitai:send-lock:${USER}`, '1');
    await expect(sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'x' })).rejects.toThrow(
      /being sent/
    );
    redisStore.clear();
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'x' });
    expect([...redisStore.keys()].filter((k) => k.includes('send-lock'))).toEqual([]);
  });

  it("does not free another sender's lock when its own has expired", async () => {
    h.createMessage.mockImplementationOnce(async ({ chatId, userId, content }) => {
      // Our lock lapsed mid-send and someone else took it.
      redisStore.set(`message-as-civitai:send-lock:${USER}`, 'someone-else');
      return postAs(chatId, userId, content);
    });
    await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'slow' });
    expect(redisStore.get(`message-as-civitai:send-lock:${USER}`)).toBe('someone-else');
  });

  it('keeps the author record when the report link cannot be written', async () => {
    const { messageId } = await sendAsCivitai({
      actorId: MOD_A,
      userId: USER,
      message: 'x',
      context: { reportId: 5000 },
    });
    const { rows } = await db.query(`SELECT "entityType", "entityId" FROM "ModActivity"`);
    expect(rows).toEqual([{ entityType: 'chatMessage', entityId: messageId }]);
  });
});

describe('sendAsCivitaiOnce', () => {
  it('sends once per idempotency key and returns the first result on a repeat', async () => {
    const input = { actorId: MOD_A, userId: USER, message: 'hi', idempotencyKey: 'key-0001' };
    const first = await sendAsCivitaiOnce(input);
    const repeat = await sendAsCivitaiOnce(input);
    expect(first.deduped).toBe(false);
    expect(repeat).toEqual({ ...first, deduped: true });
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('treats a reused key with edited text, or for another user, as a new message', async () => {
    const key = 'key-0003';
    await sendAsCivitaiOnce({
      actorId: MOD_A,
      userId: USER,
      message: 'first',
      idempotencyKey: key,
    });
    const edited = await sendAsCivitaiOnce({
      actorId: MOD_A,
      userId: USER,
      message: 'edited',
      idempotencyKey: key,
    });
    const other = await sendAsCivitaiOnce({
      actorId: MOD_A,
      userId: OTHER_USER,
      message: 'first',
      idempotencyKey: key,
    });
    expect([edited.deduped, other.deduped]).toEqual([false, false]);
    expect(h.createMessage).toHaveBeenCalledTimes(3);
  });

  it('marks a send in progress only briefly, and keeps the result for a day', async () => {
    await sendAsCivitaiOnce({
      actorId: MOD_A,
      userId: USER,
      message: 'hi',
      idempotencyKey: 'key-0004',
    });
    const writes = redisMock.sysRedis.set.mock.calls.filter(([k]) =>
      String(k).includes('idempotency')
    );
    expect(writes.map(([, v, opts]) => [v === 'pending' ? 'pending' : 'result', opts?.EX])).toEqual(
      [
        ['pending', 300],
        ['result', 86400],
      ]
    );
  });

  it('frees the key when the send fails, so a retry can succeed', async () => {
    const input = { actorId: MOD_A, userId: BANNED, message: 'hi', idempotencyKey: 'key-0002' };
    await expect(sendAsCivitaiOnce(input)).rejects.toThrow();
    expect(redisStore.size).toBe(0);
  });
});

describe('claims', () => {
  it('lets a moderator take an expired claim, but not an unexpired one held by someone else', async () => {
    await db.query(
      `INSERT INTO "ModThreadClaim" ("chatId", "moderatorId", "expiresAt") VALUES
       (1, ${MOD_A}, now() + interval '10 minutes'), (2, ${MOD_A}, now() - interval '1 minute')`
    );
    expect(await claimThread({ chatId: 1, moderatorId: MOD_B })).toEqual(
      expect.objectContaining({ claimed: false, moderatorId: MOD_A })
    );
    expect(await claimThread({ chatId: 2, moderatorId: MOD_B })).toEqual(
      expect.objectContaining({ claimed: true, moderatorId: MOD_B })
    );
  });

  it("renews the holder's own claim", async () => {
    await db.query(
      `INSERT INTO "ModThreadClaim" ("chatId", "moderatorId", "expiresAt")
       VALUES (1, ${MOD_A}, now() + interval '1 minute')`
    );
    const renewed = await claimThread({ chatId: 1, moderatorId: MOD_A });
    expect(renewed.claimed).toBe(true);
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
  });

  it("releases only the holder's claim", async () => {
    await claimThread({ chatId: 1, moderatorId: MOD_A });
    expect(await releaseThread({ chatId: 1, moderatorId: MOD_B })).toBe(false);
    expect(await releaseThread({ chatId: 1, moderatorId: MOD_A })).toBe(true);
    expect(await claimThread({ chatId: 1, moderatorId: MOD_B })).toEqual(
      expect.objectContaining({ claimed: true })
    );
  });
});

describe('inbox and thread', () => {
  it('lists a thread as awaiting only when the user spoke last', async () => {
    const answered = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'hello' });
    await postAs(answered.chatId, USER, 'a question');
    await sendAsCivitai({ actorId: MOD_A, userId: OTHER_USER, message: 'hello' });

    const awaiting = await getInbox();
    expect(awaiting.map((t) => t.userId)).toEqual([USER]);
    expect(awaiting[0]).toEqual(
      expect.objectContaining({
        lastMessage: 'a question',
        lastMessageFromCivitai: false,
        claimedBy: MOD_A,
      })
    );
    expect((await getInbox({ awaitingOnly: false })).map((t) => t.userId).sort()).toEqual([
      USER,
      OTHER_USER,
    ]);
  });

  it('lists the longest-waiting thread first', async () => {
    const older = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'hello' });
    const newer = await sendAsCivitai({ actorId: MOD_A, userId: OTHER_USER, message: 'hello' });
    await postAs(newer.chatId, OTHER_USER, 'recent reply', 1);
    await postAs(older.chatId, USER, 'old reply', 30);
    expect((await getInbox()).map((t) => t.userId)).toEqual([USER, OTHER_USER]);
  });

  it('shows which moderator wrote each Civitai Moderation message', async () => {
    const { chatId } = await sendAsCivitai({ actorId: MOD_A, userId: USER, message: 'from a' });
    await postAs(chatId, USER, 'reply');
    await releaseThread({ chatId, moderatorId: MOD_A });
    await sendAsCivitai({ actorId: MOD_B, userId: USER, message: 'from b' });

    const { messages } = await getThread({ userId: USER });
    expect(messages.map((m) => [m.content, m.fromCivitai, m.sentByUsername])).toEqual([
      ['from a', true, 'mod-a'],
      ['reply', false, null],
      ['from b', true, 'mod-b'],
    ]);
  });

  it('names the moderator behind each shared-account message for the chat audit view', async () => {
    const { chatId, messageId } = await sendAsCivitai({
      actorId: MOD_A,
      userId: USER,
      message: 'x',
    });
    const reply = await postAs(chatId, USER, 'reply');
    expect(await getMessageAuthors([messageId, reply.id])).toEqual({ [messageId]: 'mod-a' });
  });
});
