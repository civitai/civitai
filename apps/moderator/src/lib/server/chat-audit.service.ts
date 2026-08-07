import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { SYSTEM_USER_ID, isInt4Id, usernameExists } from './users.service';

// The PAGE LOAD half of Chat Audit (Retool's "Chat Audit" app) — search, the chat list, a transcript and
// the member panel. The expensive aggregates live in chat-insights.service.ts behind
// `/api/chat-insights`, and the report queue comes from reports.service.ts. One file per endpoint, same
// rule as the other lookup pages.
//
// READS PRIVATE DIRECT MESSAGES. Access is grant-based, so the page is admin-only until someone grants
// it on /admin — the right default here, and it should stay deliberate.
//
// `ChatMessage` is 4.2M rows indexed only on (id) and (chatId, userId): nothing on `content`,
// `createdAt` or `userId` alone, so anything not chat-scoped is a sequential scan.

export type ChatSummary = {
  chatId: number;
  ownerId: number | null;
  owner: string | null;
  ownerBannedAt: Date | null;
  members: string[];
  messages: number;
  lastAt: Date | null;
};

export type ChatMessageRow = {
  id: number;
  createdAt: Date;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  content: string;
};

export type ChatMessageWithChat = ChatMessageRow & { chatId: number };

export type ChatMemberRow = {
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  isOwner: boolean;
  status: string;
  joinedAt: Date | null;
  leftAt: Date | null;
  kickedAt: Date | null;
};

export type SearchMode = 'chat' | 'user' | 'content';

export type ChatSearch = {
  mode: SearchMode;
  term: string;
  chats: ChatSummary[];
  truncated: boolean;
  slow: boolean;
  /** The term is all digits AND a real username, so the moderator may have meant the person rather than
   *  the chat. Set so the page can offer the other reading instead of silently showing strangers' DMs. */
  ambiguousUsername: boolean;
};

// Retool had three inputs (chat id / username / message content), each with its own query. One box, with
// the mode inferred — but the inference is the dangerous part, so the rules are explicit:
//
//   leading @              -> username, always. The escape hatch for a numeric username.
//   all digits within int4 -> chat id.
//   all digits above int4  -> username. It cannot be a chat id, and feeding it to a chatId comparison
//                             ERRORS the query and 500s the page rather than missing — 978 users with a
//                             10+ digit numeric username have chat messages.
//   short simple word      -> username
//   anything else          -> message content
const USERNAME_SHAPE = /^[\w.-]{3,50}$/;

export function classifySearch(term: string): SearchMode {
  if (term.startsWith('@')) return 'user';
  if (/^\d+$/.test(term)) return isInt4Id(Number(term)) ? 'chat' : 'user';
  return USERNAME_SHAPE.test(term) ? 'user' : 'content';
}

/** `%` and `_` are LIKE metacharacters. Kysely binds the value, so this is not injection — but an
 *  unescaped `100%` matches "1000 buzz", and a bare `%` matches every message on the site. */
const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => '\\' + c);

const SEARCH_LIMIT = 50;

export async function searchChats(rawTerm: string): Promise<ChatSearch | null> {
  const term = rawTerm.trim();
  if (!term) return null;

  const mode = classifySearch(term);
  const { ids, truncated } = await findChatIds(mode, term);

  return {
    mode,
    term,
    truncated,
    // Content search has no index to use — 4.2M rows, ~3s. Only runs when a moderator asks for it.
    slow: mode === 'content',
    ambiguousUsername: mode === 'chat' && (await usernameExists(term)),
    chats: ids.length ? await summariseChats(ids) : [],
  };
}

// Every branch orders before it limits. Without an ORDER BY, `SELECT DISTINCT chatId ... LIMIT 50` is
// satisfied by a sort/unique on chatId, so it returned the 50 LOWEST ids — the 50 OLDEST chats — and
// summariseChats then re-sorted them by recency, so the list READ as "newest first". A search for
// `discord.gg` matches 4,774 chats; the moderator saw 50 ancient ones and no sign there were more.
async function findChatIds(
  mode: SearchMode,
  term: string
): Promise<{ ids: number[]; truncated: boolean }> {
  if (mode === 'chat') {
    const id = Number(term);
    return { ids: isInt4Id(id) ? [id] : [], truncated: false };
  }

  const take = (rows: { chatId: number }[]) => ({
    ids: rows.slice(0, SEARCH_LIMIT).map((r) => r.chatId),
    truncated: rows.length > SEARCH_LIMIT,
  });

  if (mode === 'user') {
    return take(
      await dbRead
        .selectFrom('ChatMessage as cm')
        .innerJoin('User as u', 'u.id', 'cm.userId')
        .select('cm.chatId')
        .distinct()
        .where('u.username', '=', term.replace(/^@/, ''))
        .orderBy('cm.chatId', 'desc')
        .limit(SEARCH_LIMIT + 1)
        .execute()
    );
  }

  return take(
    await dbRead
      .selectFrom('ChatMessage')
      .select('chatId')
      .distinct()
      .where('content', 'ilike', '%' + escapeLike(term) + '%')
      .where('userId', '!=', SYSTEM_USER_ID)
      .orderBy('chatId', 'desc')
      .limit(SEARCH_LIMIT + 1)
      .execute()
  );
}

// Retool's FindChats joined member names with string_agg and split on ',', which corrupts any username
// containing a comma. A real array avoids inventing a delimiter.
async function summariseChats(chatIds: number[]): Promise<ChatSummary[]> {
  const rows = await dbRead
    .selectFrom('ChatMember as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select([
      'cm.chatId',
      sql<number | null>`max(case when cm."isOwner" then cm."userId" end)`.as('ownerId'),
      sql<string | null>`max(case when cm."isOwner" then u.username end)`.as('owner'),
      sql<Date | null>`max(case when cm."isOwner" then u."bannedAt" end)`.as('ownerBannedAt'),
      // Two things are load-bearing here.
      //
      // `::text` — username is citext, and node-pg has no parser for citext[], so the driver returns
      // the raw Postgres literal as a STRING and the panel's .join() throws on it.
      //
      // `coalesce` — 8,589 users with a NULL username hold 34,147 membership rows. Dropping them made
      // the chat list and the member panel disagree about who was in a conversation: a chat with a
      // purged counterparty rendered with no "with ..." clause at all.
      sql<string[]>`coalesce(
        array_agg(coalesce(u.username::text, '#' || cm."userId")) filter (where not cm."isOwner"),
        '{}'
      )`.as('members'),
    ])
    .where('cm.chatId', 'in', chatIds)
    .groupBy('cm.chatId')
    .execute();

  // System rows are 14% of the table, and 51,245 chats contain nothing else — counting them made an
  // empty conversation read as "1 messages".
  const counts = await dbRead
    .selectFrom('ChatMessage')
    .select((eb) => [
      'chatId',
      eb.fn.countAll<string>().as('messages'),
      eb.fn.max('createdAt').as('lastAt'),
    ])
    .where('chatId', 'in', chatIds)
    .where('userId', '!=', SYSTEM_USER_ID)
    .groupBy('chatId')
    .execute();
  const byChat = new Map(counts.map((c) => [c.chatId, c]));

  return rows
    .map((r) => ({
      chatId: r.chatId,
      ownerId: r.ownerId,
      owner: r.owner,
      ownerBannedAt: r.ownerBannedAt,
      members: r.members ?? [],
      messages: Number(byChat.get(r.chatId)?.messages ?? 0),
      lastAt: byChat.get(r.chatId)?.lastAt ?? null,
    }))
    .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

// The transcript. Chat-scoped, so it rides the (chatId, userId) index.
//
// System rows are excluded: 274,106 of them are `contentType = 'Embed'` whose content is a raw JSON
// blob, which rendered verbatim attributed to "civitai" and ate slots in the cap.
export async function getTranscript(
  chatId: number,
  limit = 300
): Promise<{ rows: ChatMessageRow[]; truncated: boolean }> {
  if (!isInt4Id(chatId)) return { rows: [], truncated: false };

  const rows = await dbRead
    .selectFrom('ChatMessage as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select(['cm.id', 'cm.createdAt', 'cm.userId', 'cm.content', 'u.username', 'u.bannedAt'])
    .where('cm.chatId', '=', chatId)
    .where('cm.userId', '!=', SYSTEM_USER_ID)
    // Newest first so the cap drops the OLDEST; reversed here for reading order.
    .orderBy('cm.createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), truncated };
}

export async function getChatMembers(chatId: number): Promise<ChatMemberRow[]> {
  if (!isInt4Id(chatId)) return [];

  const rows = await dbRead
    .selectFrom('ChatMember as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select([
      'cm.userId',
      'cm.isOwner',
      'cm.status',
      'cm.joinedAt',
      'cm.leftAt',
      'cm.kickedAt',
      'u.username',
      'u.bannedAt',
    ])
    .where('cm.chatId', '=', chatId)
    .execute();
  return rows.map((r) => ({ ...r, status: String(r.status) }));
}

export async function getUserMessages(
  username: string,
  limit = 100
): Promise<{ rows: ChatMessageWithChat[]; chats: number; truncated: boolean } | null> {
  const name = username.replace(/^@/, '');

  // Null for an unresolved term, not an empty result. `USERNAME_SHAPE` matches things that are not
  // usernames — `discord.gg` is the commonest DM-spam string on the site — and rendering those as an
  // account with no messages tells a moderator the opposite of the truth.
  if (!(await usernameExists(name))) return null;

  // `chats` counts over the whole account, not over the page. Deriving it from the newest 100 rows
  // understated a 458-chat DM blast as 12 — and breadth is the number that separates a chatty user
  // from a spammer.
  const [rows, distinct] = await Promise.all([
    dbRead
      .selectFrom('ChatMessage as cm')
      .innerJoin('User as u', 'u.id', 'cm.userId')
      .select([
        'cm.id',
        'cm.createdAt',
        'cm.userId',
        'cm.content',
        'cm.chatId',
        'u.username',
        'u.bannedAt',
      ])
      .where('u.username', '=', name)
      .where('cm.userId', '!=', SYSTEM_USER_ID)
      .orderBy('cm.createdAt', 'desc')
      .limit(limit + 1)
      .execute(),
    dbRead
      .selectFrom('ChatMessage as cm')
      .innerJoin('User as u', 'u.id', 'cm.userId')
      .select((eb) => eb.fn.count<string>('cm.chatId').distinct().as('n'))
      .where('u.username', '=', name)
      .where('cm.userId', '!=', SYSTEM_USER_ID)
      .executeTakeFirst(),
  ]);

  return {
    truncated: rows.length > limit,
    chats: Number(distinct?.n ?? 0),
    rows: rows.slice(0, limit),
  };
}

/** Does this chat exist at all? Separates "empty conversation" from "no such chat" — a shared link with
 *  a typo'd id otherwise rendered as a real but silent conversation. */
export async function chatExists(chatId: number): Promise<boolean> {
  if (!isInt4Id(chatId)) return false;
  const row = await dbRead
    .selectFrom('Chat')
    .select('id')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return !!row;
}
