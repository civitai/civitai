import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { usersByIds } from './users.service';

// The PAGE LOAD half of Chat Audit (Retool's "Chat Audit" app) — search, the chat list, a transcript and
// the chat-report queue. The expensive aggregate half lives in chat-insights.service.ts behind
// `/api/chat-insights`. One file per endpoint, same rule as the other lookup pages.
//
// READS PRIVATE DIRECT MESSAGES. Access is grant-based, so the page is admin-only until someone grants
// it explicitly on /admin — that default is the right one here and should stay deliberate.
//
// `ChatMessage` is 4.2M rows indexed only on (id) and (chatId, userId): there is no index on `content`,
// `createdAt` or `userId` alone, so anything that is not chat-scoped is a sequential scan. Measured, and
// the numbers drive where each query runs.

/** System messages ("<name> joined") are written by account -1 and are never what a moderator wants. */
const SYSTEM_USER_ID = -1;

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

export type ChatReportRow = {
  reportId: number;
  chatId: number;
  reason: string;
  status: string;
  createdAt: Date;
  comment: string | null;
  reportedById: number;
  reportedBy: string | null;
};

export type SearchMode = 'chat' | 'user' | 'content';

/** What the one search box did with the term, so the page can say so rather than leaving it a guess. */
export type ChatSearch = { mode: SearchMode; term: string; chats: ChatSummary[]; slow: boolean };

// Retool had three separate inputs — a chat-id box, a username box and a content box — each driving its
// own query. One box instead, matching the other lookup pages: digits are a chat id, a leading @ or a
// bare username is a user, anything else is message content.
export function classifySearch(term: string): SearchMode {
  if (/^\d+$/.test(term)) return 'chat';
  if (/^@/.test(term)) return 'user';
  return /^[\w.-]{3,50}$/.test(term) ? 'user' : 'content';
}

export async function searchChats(rawTerm: string, limit = 50): Promise<ChatSearch | null> {
  const term = rawTerm.trim();
  if (!term) return null;

  const mode = classifySearch(term);
  const chatIds = await findChatIds(mode, term, limit);
  return {
    mode,
    term,
    // Content search has no index to use — 4.2M rows, ~3s. It only runs when a moderator asks for it,
    // but the page says so rather than looking hung.
    slow: mode === 'content',
    chats: chatIds.length ? await summariseChats(chatIds) : [],
  };
}

async function findChatIds(mode: SearchMode, term: string, limit: number): Promise<number[]> {
  if (mode === 'chat') {
    const id = Number(term);
    return Number.isInteger(id) && id > 0 ? [id] : [];
  }

  if (mode === 'user') {
    const username = term.replace(/^@/, '');
    const rows = await dbRead
      .selectFrom('ChatMessage as cm')
      .innerJoin('User as u', 'u.id', 'cm.userId')
      .select('cm.chatId')
      .distinct()
      .where('u.username', '=', username)
      .limit(limit)
      .execute();
    return rows.map((r) => r.chatId);
  }

  const rows = await dbRead
    .selectFrom('ChatMessage')
    .select('chatId')
    .distinct()
    // Kysely escapes the parameter; the wildcards are ours. A term of only wildcards would match
    // everything, so it is rejected before we get here by the length check in classifySearch.
    .where('content', 'ilike', `%${term}%`)
    .where('userId', '!=', SYSTEM_USER_ID)
    .limit(limit)
    .execute();
  return rows.map((r) => r.chatId);
}

// Retool's FindChats built the member list with string_agg + string_to_array, which breaks on any
// username containing a comma. Aggregating into a real array avoids inventing a delimiter.
async function summariseChats(chatIds: number[]): Promise<ChatSummary[]> {
  const rows = await dbRead
    .selectFrom('ChatMember as cm')
    .innerJoin('User as u', 'u.id', 'cm.userId')
    .select((eb) => [
      'cm.chatId',
      sql<number | null>`max(case when cm."isOwner" then u.id end)`.as('ownerId'),
      sql<string | null>`max(case when cm."isOwner" then u.username end)`.as('owner'),
      sql<Date | null>`max(case when cm."isOwner" then u."bannedAt" end)`.as('ownerBannedAt'),
      sql<string[]>`array_remove(array_agg(u.username::text) filter (where not cm."isOwner"), null)`.as(
        'members'
      ),
      eb.fn.countAll<string>().as('memberCount'),
    ])
    .where('cm.chatId', 'in', chatIds)
    .groupBy('cm.chatId')
    .execute();

  const counts = await dbRead
    .selectFrom('ChatMessage')
    .select((eb) => [
      'chatId',
      eb.fn.countAll<string>().as('messages'),
      eb.fn.max('createdAt').as('lastAt'),
    ])
    .where('chatId', 'in', chatIds)
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

// The transcript. Chat-scoped, so it rides the (chatId, userId) index — 4.2M rows is irrelevant here.
// Capped: a long-running chat can carry thousands, and the cap is disclosed rather than silent.
export async function getTranscript(
  chatId: number,
  limit = 300
): Promise<{ rows: ChatMessageRow[]; truncated: boolean }> {
  const rows = await dbRead
    .selectFrom('ChatMessage as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select(['cm.id', 'cm.createdAt', 'cm.userId', 'cm.content', 'u.username', 'u.bannedAt'])
    .where('cm.chatId', '=', chatId)
    // Newest first so the cap drops the OLDEST; the page reverses for reading order.
    .orderBy('cm.createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), truncated };
}

export async function getChatMembers(chatId: number): Promise<ChatMemberRow[]> {
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

// Retool's ChatReport pulled every non-Automated chat report with no bound and no pagination. Kept as a
// queue: newest first, capped, with the reporter resolved.
export async function getChatReports(limit = 50): Promise<ChatReportRow[]> {
  const rows = await dbRead
    .selectFrom('ChatReport as cr')
    .innerJoin('Report as r', 'r.id', 'cr.reportId')
    .select([
      'cr.chatId',
      'r.id as reportId',
      'r.reason',
      'r.status',
      'r.createdAt',
      'r.userId as reportedById',
      sql<string | null>`r.details ->> 'comment'`.as('comment'),
    ])
    .where('r.reason', '!=', 'Automated')
    .orderBy('r.createdAt', 'desc')
    .limit(limit)
    .execute();

  const byId = await usersByIds(rows.map((r) => r.reportedById));
  return rows.map((r) => ({
    ...r,
    reason: String(r.reason),
    status: String(r.status),
    reportedBy: byId.get(r.reportedById)?.username ?? null,
  }));
}
