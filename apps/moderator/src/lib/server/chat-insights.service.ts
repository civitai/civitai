import { dbRead } from './db';
import { usersByIds } from './users.service';

// Everything behind `/api/chat-insights` — the platform-wide aggregates Retool showed as a stats strip,
// plus its spam detector. Every query here scans `ChatMessage` (4.2M rows, no index on `createdAt` or
// `userId`), so none of it belongs on the page load.
//
// One file per endpoint, same rule as the other pages' services.

const SYSTEM_USER_ID = -1;

export type TopChatter = { userId: number; username: string | null; bannedAt: Date | null; messages: number };
export type TopChat = { chatId: number; messages: number };

export type ChatStats = {
  chats: number;
  chats24h: number;
  messages: number;
  messages24h: number;
  topChatters: TopChatter[];
  topChats: TopChat[];
};

export type SpamGroup = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  content: string;
  chats: number;
};

export async function getChatStats(): Promise<ChatStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [chats, chats24h, messages, messages24h, chatters, topChats] = await Promise.all([
    dbRead
      .selectFrom('Chat')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst(),
    dbRead
      .selectFrom('Chat')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('createdAt', '>', since)
      .executeTakeFirst(),
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('userId', '!=', SYSTEM_USER_ID)
      .executeTakeFirst(),
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('userId', '!=', SYSTEM_USER_ID)
      .where('createdAt', '>', since)
      .executeTakeFirst(),
    // Grouping by userId alone and resolving names afterwards, rather than Retool's GROUP BY username,
    // id — a rename mid-window would otherwise split one person into two rows.
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => ['userId', eb.fn.countAll<string>().as('n')])
      .where('userId', '!=', SYSTEM_USER_ID)
      .groupBy('userId')
      .orderBy('n', 'desc')
      .limit(25)
      .execute(),
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => ['chatId', eb.fn.countAll<string>().as('n')])
      .where('userId', '!=', SYSTEM_USER_ID)
      .groupBy('chatId')
      .orderBy('n', 'desc')
      .limit(20)
      .execute(),
  ]);

  const byId = await usersByIds(chatters.map((c) => c.userId));
  return {
    chats: Number(chats?.n ?? 0),
    chats24h: Number(chats24h?.n ?? 0),
    messages: Number(messages?.n ?? 0),
    messages24h: Number(messages24h?.n ?? 0),
    topChatters: chatters.map((c) => ({
      userId: c.userId,
      username: byId.get(c.userId)?.username ?? null,
      bannedAt: byId.get(c.userId)?.bannedAt ?? null,
      messages: Number(c.n),
    })),
    topChats: topChats.map((c) => ({ chatId: c.chatId, messages: Number(c.n) })),
  };
}

// SPAM DETECTION (Retool's SPAMDetect), and the most useful thing on the page: the same message text
// sent by one account into more than one chat. That is what DM spam looks like.
//
// Retool ran it UNBOUNDED. Measured on the replica: 5.3s and a 429MB external merge sort spilling to
// disk, because it groups 4.2M rows by full message text. A 30-day window is 630ms with no spill — and
// spam a moderator can still act on is recent by definition. The window is returned so the panel can
// say what it covered rather than implying "ever".
export async function getSpamGroups(
  days = 30,
  minChats = 2,
  limit = 50
): Promise<{ groups: SpamGroup[]; days: number; truncated: boolean }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await dbRead
    .selectFrom('ChatMessage as cm')
    .select((eb) => [
      'cm.userId',
      'cm.content',
      eb.fn.count<string>('cm.chatId').distinct().as('chats'),
    ])
    .where('cm.userId', '!=', SYSTEM_USER_ID)
    .where('cm.createdAt', '>', since)
    .groupBy(['cm.userId', 'cm.content'])
    .having((eb) => eb.fn.count('cm.chatId').distinct(), '>=', minChats)
    .orderBy('chats', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const byId = await usersByIds(page.map((r) => r.userId));

  return {
    days,
    truncated,
    groups: page.map((r, i) => ({
      // (userId, content) is the group, but content can be long — an ordinal keeps the list key short
      // and stable without hashing message text.
      key: `${i}:${r.userId}`,
      userId: r.userId,
      username: byId.get(r.userId)?.username ?? null,
      bannedAt: byId.get(r.userId)?.bannedAt ?? null,
      content: r.content,
      chats: Number(r.chats),
    })),
  };
}
