import { dbRead } from './db';
import type { ChatMessageWithChat } from './chat-audit.service';
import { SYSTEM_USER_ID, usersByIds } from './users.service';

// Everything behind `/api/chat-insights` — the platform-wide aggregates Retool showed as a stats strip,
// plus its spam detector. Every query here scans `ChatMessage` (4.2M rows, no index on `createdAt` or
// `userId`), so none of it belongs on the page load.
//
// One file per endpoint, same rule as the other pages' services.

export type TopChatter = {
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  messages: number;
};

export type TopChat = { chatId: number; messages: number };

export type ChatStats = {
  chats: number;
  chats24h: number;
  messages: number;
  messages24h: number;
  /** All-time and last-24h are different questions: all-time finds the heaviest accounts, 24h finds who
   *  is spamming RIGHT NOW. Retool showed both and only one was ported. */
  topChatters: TopChatter[];
  topChatters24h: TopChatter[];
  chattersCapped: boolean;
  chattersCapped24h: boolean;
  topChats: TopChat[];
  topChats24h: TopChat[];
};

export type NewestMessage = ChatMessageWithChat;

export type SpamGroup = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  content: string;
  chats: number;
};

const TOP_CHATTERS = 50;
const TOP_CHATS = 20;

export async function getChatStats(): Promise<ChatStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const topChatters = (bounded: boolean) =>
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => ['userId', eb.fn.countAll<string>().as('n')])
      .where('userId', '!=', SYSTEM_USER_ID)
      .$if(bounded, (qb) => qb.where('createdAt', '>', since))
      // Grouping by userId alone and resolving names afterwards, rather than Retool's GROUP BY
      // (username, id) — a rename mid-window would otherwise split one person into two rows.
      .groupBy('userId')
      .orderBy('n', 'desc')
      .limit(TOP_CHATTERS + 1)
      .execute();

  const topChats = (bounded: boolean) =>
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => ['chatId', eb.fn.countAll<string>().as('n')])
      .where('userId', '!=', SYSTEM_USER_ID)
      .$if(bounded, (qb) => qb.where('createdAt', '>', since))
      .groupBy('chatId')
      .orderBy('n', 'desc')
      .limit(TOP_CHATS)
      .execute();

  const [chats, chats24h, messages, messages24h, chatters, chatters24, chatRows, chatRows24] =
    await Promise.all([
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
      topChatters(false),
      topChatters(true),
      topChats(false),
      topChats(true),
    ]);

  const page = chatters.slice(0, TOP_CHATTERS);
  const page24 = chatters24.slice(0, TOP_CHATTERS);

  const byId = await usersByIds([...page, ...page24].map((c) => c.userId));
  const hydrate = (rows: { userId: number; n: string }[]) =>
    rows.map((c) => ({
      userId: c.userId,
      username: byId.get(c.userId)?.username ?? null,
      bannedAt: byId.get(c.userId)?.bannedAt ?? null,
      messages: Number(c.n),
    }));

  return {
    chats: Number(chats?.n ?? 0),
    chats24h: Number(chats24h?.n ?? 0),
    messages: Number(messages?.n ?? 0),
    messages24h: Number(messages24h?.n ?? 0),
    chattersCapped: chatters.length > TOP_CHATTERS,
    chattersCapped24h: chatters24.length > TOP_CHATTERS,
    topChatters: hydrate(page),
    topChatters24h: hydrate(page24),
    topChats: chatRows.map((c) => ({ chatId: c.chatId, messages: Number(c.n) })),
    topChats24h: chatRows24.map((c) => ({ chatId: c.chatId, messages: Number(c.n) })),
  };
}

// The "Newest" tab: a live feed of the most recent messages platform-wide. Retool let a moderator set the
// row count; this is a fixed cap because the query has no index to use — `createdAt` is unindexed, so it
// is a full scan plus a top-N sort (~700ms) regardless of how many rows come back.
export async function getNewestMessages(limit = 100): Promise<NewestMessage[]> {
  const rows = await dbRead
    .selectFrom('ChatMessage as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select([
      'cm.id',
      'cm.chatId',
      'cm.userId',
      'cm.content',
      'cm.createdAt',
      'u.username',
      'u.bannedAt',
    ])
    .where('cm.userId', '!=', SYSTEM_USER_ID)
    .orderBy('cm.createdAt', 'desc')
    .limit(limit)
    .execute();
  return rows;
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
    groups: page.map((r) => ({
      // The group IS (userId, content); an index would be position-derived and no better than an
      // unkeyed each. Content can be long, so it is hashed rather than embedded whole.
      key: `${r.userId}:${hash(r.content)}`,
      userId: r.userId,
      username: byId.get(r.userId)?.username ?? null,
      bannedAt: byId.get(r.userId)?.bannedAt ?? null,
      content: r.content,
      chats: Number(r.chats),
    })),
  };
}

/** Short stable digest of a message body, for list keys only — never for identity or storage. */
function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
