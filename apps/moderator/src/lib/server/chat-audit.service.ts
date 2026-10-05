import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { SYSTEM_USER_ID, isInt4Id, usernameExists } from './users.service';

// The PAGE LOAD half of Chat Audit (Retool's "Chat Audit" app) — search, the chat list, a transcript and
// the member panel. The expensive aggregates live in chat-insights.service.ts behind
// `/api/chat-insights`, and the report queue comes from reports.service.ts. One file per endpoint, same
// rule as the other lookup pages.
//
// READS PRIVATE DIRECT MESSAGES. Access is grant-based, so the page is admin-only until someone grants
// it on /admin — the right default here, and it should stay deliberate.
//
// `ChatMessage` is 4.2M rows indexed only on (id) and (chatId, id): nothing on `content`,
// `createdAt` or `userId` alone, so anything not chat-scoped is a sequential scan.

/** Carries the id, not just the name: every username on this page links to that account's lookup, and
 *  a name alone cannot be resolved back to one — usernames are reusable, and ~8.5k accounts have none. */
export type ChatMemberSummary = { userId: number; username: string | null };

export type ChatSummary = {
  chatId: number;
  ownerId: number | null;
  owner: string | null;
  ownerBannedAt: Date | null;
  members: ChatMemberSummary[];
  messages: number;
  lastAt: Date | null;
  /** One message, so the row can be judged without opening it. Retool showed an excerpt and this list
   *  did not, so confirming spam or harassment meant opening every result in turn. */
  excerpt: ChatExcerpt | null;
};

export type ChatExcerpt = {
  content: string;
  createdAt: Date;
  username: string | null;
  userId: number;
  /** Whether this is the matched message or just the latest, so the panel does not imply a match it
   *  cannot show — a username search matches the sender, not any particular message. */
  matched: boolean;
  /** Deleted messages are eligible: excluding them meant a content search that matched a since-removed
   *  message showed that chat with no excerpt at all, which is the case worth reading. */
  deleted: boolean;
};

export type ChatMessageRow = {
  id: number;
  createdAt: Date;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  content: string;
  /** Set when the sender rewrote the message. The ORIGINAL text is not kept on the row — an edit
   *  overwrites `content` — so it comes from the audit log instead; see `getMessageEdits`. */
  editedAt: Date | null;
  /** Deleted messages are hidden from both participants but retained for exactly this. A report is
   *  usually filed about a message the sender then removed, so omitting them hid the evidence. */
  deletedAt: Date | null;
};

/**
 * ONE edit, from the `chatAuditEvents` log — the only place a superseded version survives.
 *
 * A message carries a LIST of these, oldest first, because 144 of the 1,025 edited messages on the
 * site were edited more than once and one was edited 21 times. Collapsing them to first-and-last
 * dropped every intermediate version, and pinned the original's text to the newest edit's timestamp —
 * so the panel dated text to a moment it did not exist at, on the screen that answers "what did this
 * say when it was reported".
 */
export type MessageEdit = {
  /** ISO, already normalised out of ClickHouse's zoneless format. When THIS edit happened. */
  at: string;
  /** The text this edit replaced. `oldValue` of the first edit is what the message was written with. */
  oldValue: string;
  /** The text it left behind — equal to the next edit's `oldValue`, and on the last edit to the
   *  message's current `content`. Verified to chain with no gaps across every multi-edit message. */
  newValue: string;
  /** The log caps each value at 4,000 chars. */
  truncated: boolean;
  /** `moderator` when someone other than the sender rewrote it. */
  actorRole: string;
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
  /** The content-search window, carried so the page states the SAME number the query used. Two
   *  independent `90`s is how a page ends up promising 90 days over a 30-day query. */
  contentSearchDays: number;
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

/**
 * Message-content search is bounded, and says so on the page.
 *
 * `ChatMessage.content` has no index, so an ILIKE is a full scan of 4.2M rows. Measured on production:
 * 1.4s for a common term and **2.6s for one with no hits** — a miss is the slow case, because proving a
 * negative reads everything, and probing an unknown spam string is exactly when a moderator misses.
 * Bounding to 90 days halves the worst case (1.2s) and covers 258k of the 4.2M rows.
 *
 * This is a mitigation, not the fix. The fix is a partial GIN trigram index on the same window —
 * `pg_trgm` is already installed in production and 90 days is only 26MB of text, so the index lands
 * around 50-90MB against the 208MB already on this table. Deferred deliberately: nothing is blocked on
 * this search, and a FULL index would cover 457MB of text for a query that is not on any hot path.
 * See `.claude/skills/retool-migration/MIGRATIONS.md` §D, "Chat message-text search performance".
 */
const CONTENT_SEARCH_DAYS = 90;

export async function searchChats(rawTerm: string): Promise<ChatSearch | null> {
  const term = rawTerm.trim();
  if (!term) return null;

  let mode = classifySearch(term);
  let { ids, truncated } = await findChatIds(mode, term);

  // `discord.gg`, `telegram`, `onlyfans` all satisfy USERNAME_SHAPE, so the commonest spam strings
  // classified as usernames, matched no account, and reported "No chats matched" — while the same term
  // matches thousands of messages. A username search that finds nothing falls through to content.
  if (mode === 'user' && !ids.length && !term.startsWith('@') && !(await usernameExists(term))) {
    mode = 'content';
    ({ ids, truncated } = await findChatIds(mode, term));
  }

  return {
    mode,
    term,
    truncated,
    // Content search has no index to use, so it scans. Only runs when a moderator asks for it.
    slow: mode === 'content',
    contentSearchDays: CONTENT_SEARCH_DAYS,
    ambiguousUsername: mode === 'chat' && (await usernameExists(term)),
    chats: ids.length ? await summariseChats(ids, mode, term) : [],
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

  const since = new Date(Date.now() - CONTENT_SEARCH_DAYS * 86_400_000);
  return take(
    await dbRead
      .selectFrom('ChatMessage')
      .select('chatId')
      .distinct()
      .where('content', 'ilike', '%' + escapeLike(term) + '%')
      .where('userId', '!=', SYSTEM_USER_ID)
      .where('createdAt', '>', since)
      .orderBy('chatId', 'desc')
      .limit(SEARCH_LIMIT + 1)
      .execute()
  );
}

// Retool's FindChats joined member names with string_agg and split on ',', which corrupts any username
// containing a comma. A real array avoids inventing a delimiter.
async function summariseChats(
  chatIds: number[],
  mode: SearchMode,
  term: string
): Promise<ChatSummary[]> {
  const rows = await dbRead
    .selectFrom('ChatMember as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select([
      'cm.chatId',
      sql<number | null>`max(case when cm."isOwner" then cm."userId" end)`.as('ownerId'),
      sql<string | null>`max(case when cm."isOwner" then u.username end)`.as('owner'),
      sql<Date | null>`max(case when cm."isOwner" then u."bannedAt" end)`.as('ownerBannedAt'),
      // `::text` — username is citext; casting keeps the JSON value a plain string.
      //
      // A NULL username is kept rather than filtered: 8,589 such users hold 34,147 membership rows, and
      // dropping them made the chat list and the member panel disagree about who was in a conversation
      // — a chat with a purged counterparty rendered with no "with ..." clause at all. The panel falls
      // back to the id, which is why the id travels.
      sql<ChatMemberSummary[]>`coalesce(
        jsonb_agg(
          jsonb_build_object('userId', cm."userId", 'username', u.username::text)
          order by u.username nulls last, cm."userId"
        ) filter (where not cm."isOwner"),
        '[]'
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
  const excerpts = await chatExcerpts(chatIds, mode, term);

  return rows
    .map((r) => ({
      chatId: r.chatId,
      ownerId: r.ownerId,
      owner: r.owner,
      ownerBannedAt: r.ownerBannedAt,
      members: r.members ?? [],
      messages: Number(byChat.get(r.chatId)?.messages ?? 0),
      lastAt: byChat.get(r.chatId)?.lastAt ?? null,
      excerpt: excerpts.get(r.chatId) ?? null,
    }))
    .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

/** Longer than a list row shows; the panel clamps it. Bounded here so a 4,000-character message does
 *  not travel 50 times per search. */
const EXCERPT_CHARS = 400;

/**
 * One message per chat, for the list. On a content search this is the message that MATCHED, because
 * "which of these 50 chats contains the thing I searched for" is the question; otherwise it is the
 * latest.
 *
 * Ordered on `id`, not `createdAt`: both are monotonic within a chat, and only `id` is in the
 * (chatId, id) index — ordering on `createdAt` costs a sort per group for the same row.
 */
async function chatExcerpts(
  chatIds: number[],
  mode: SearchMode,
  term: string
): Promise<Map<number, ChatExcerpt>> {
  const matching = mode === 'content';
  const filter = matching
    ? sql`and cm.content ilike ${'%' + escapeLike(term) + '%'} escape '\\'`
    : mode === 'user'
    ? sql`and u.username = ${term.replace(/^@/, '')}`
    : sql``;

  const { rows } = await sql<{
    chatId: number;
    content: string;
    createdAt: Date;
    username: string | null;
    userId: number;
    deletedAt: Date | null;
  }>`
    select distinct on (cm."chatId")
      -- Trimmed before the cut: the excerpt is clamped to three lines, and a message opening with
      -- blank ones spends them saying nothing.
      cm."chatId", left(btrim(cm.content), ${EXCERPT_CHARS}) as content, cm."createdAt", cm."userId",
      cm."deletedAt", u.username::text as username
    from "ChatMessage" cm
    left join "User" u on u.id = cm."userId"
    where cm."chatId" = any(${chatIds})
      and cm."userId" != ${SYSTEM_USER_ID}
      ${filter}
    order by cm."chatId", cm.id desc
  `.execute(dbRead);

  return new Map(
    rows.map((r) => [
      r.chatId,
      {
        content: r.content,
        createdAt: r.createdAt,
        username: r.username,
        userId: r.userId,
        matched: matching,
        deleted: r.deletedAt !== null,
      },
    ])
  );
}

// The transcript. Chat-scoped, so it rides the (chatId, id) index.
//
// System rows are excluded: 274,106 of them are `contentType = 'Embed'` whose content is a raw JSON
// blob, which rendered verbatim attributed to "civitai" and ate slots in the cap.
//
// Deleted rows are INCLUDED. `deletedAt` hides a message from both participants and keeps the row for
// moderation, so a report filed about a message the sender then removed pointed at a transcript that
// did not contain it.
export async function getTranscript(
  chatId: number,
  limit = 300
): Promise<{
  rows: ChatMessageRow[];
  truncated: boolean;
  /** Every edit per message, oldest first. Null when the audit log could not be read — distinct from
   *  an empty map, which says the log was read and holds nothing for these messages. */
  edits: Record<number, MessageEdit[]> | null;
}> {
  if (!isInt4Id(chatId)) return { rows: [], truncated: false, edits: {} };

  const rows = await dbRead
    .selectFrom('ChatMessage as cm')
    .leftJoin('User as u', 'u.id', 'cm.userId')
    .select([
      'cm.id',
      'cm.createdAt',
      'cm.userId',
      'cm.content',
      'cm.editedAt',
      'cm.deletedAt',
      'u.username',
      'u.bannedAt',
    ])
    .where('cm.chatId', '=', chatId)
    .where('cm.userId', '!=', SYSTEM_USER_ID)
    // Newest first so the cap drops the OLDEST; reversed here for reading order.
    .orderBy('cm.createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const edited = page.filter((r) => r.editedAt).map((r) => r.id);

  return { rows: page, truncated, edits: await getMessageEdits(chatId, edited) };
}

/**
 * The text a message had BEFORE it was edited, from the `chatAuditEvents` ClickHouse log — Postgres
 * keeps only the current version. Best-effort: the log being down must not take the transcript with it.
 */
async function getMessageEdits(
  chatId: number,
  messageIds: number[]
): Promise<Record<number, MessageEdit[]> | null> {
  if (!messageIds.length) return {};

  try {
    const rows = await getClickhouse().$query<{
      messageId: string;
      createdAt: string;
      oldValue: string;
      newValue: string;
      truncated: number;
      actorRole: string;
    }>(`
      SELECT messageId, createdAt, oldValue, newValue, truncated, actorRole
      FROM default.chatAuditEvents
      WHERE type = 'edit'
        AND chatId = ${chatId}
        AND messageId IN (${messageIds.join(',')})
      -- Oldest first, so the list reads as the order the message was rewritten in.
      ORDER BY createdAt ASC
    `);

    const byMessage: Record<number, MessageEdit[]> = {};
    for (const r of rows) {
      const id = Number(r.messageId);
      (byMessage[id] ??= []).push({
        at: clickhouseDate(r.createdAt),
        oldValue: r.oldValue,
        newValue: r.newValue,
        truncated: r.truncated === 1,
        actorRole: r.actorRole,
      });
    }
    return byMessage;
  } catch (e) {
    // NULL, not `{}`. An empty map is a claim — "this message has no recorded original" — and the
    // panel states it as one. A misnamed column here already produced exactly that: every edited
    // message reporting its original unrecoverable, which reads like a gap in the log rather than a
    // broken query, so nobody would report it.
    console.error('[chat-audit] message edit history unavailable', e);
    return null;
  }
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

export type UserMessages = { rows: ChatMessageWithChat[]; chats: number; truncated: boolean };

/**
 * `getUserMessages` keyed by id, for User Lookup — which has resolved the account already and must not
 * re-resolve it by name. A rename between the two lookups would silently answer about whoever holds the
 * old name now, and usernames are reusable.
 */
export async function getUserMessagesById(userId: number, limit = 50): Promise<UserMessages> {
  if (!isInt4Id(userId)) return { rows: [], chats: 0, truncated: false };

  const [rows, distinct] = await Promise.all([
    dbRead
      .selectFrom('ChatMessage as cm')
      .leftJoin('User as u', 'u.id', 'cm.userId')
      .select([
        'cm.id',
        'cm.createdAt',
        'cm.userId',
        'cm.content',
        'cm.chatId',
        'cm.editedAt',
        'cm.deletedAt',
        'u.username',
        'u.bannedAt',
      ])
      .where('cm.userId', '=', userId)
      .orderBy('cm.createdAt', 'desc')
      .limit(limit + 1)
      .execute(),
    dbRead
      .selectFrom('ChatMessage')
      .select((eb) => eb.fn.count<string>('chatId').distinct().as('n'))
      .where('userId', '=', userId)
      .executeTakeFirst(),
  ]);

  return {
    truncated: rows.length > limit,
    chats: Number(distinct?.n ?? 0),
    rows: rows.slice(0, limit),
  };
}

export async function getUserMessages(username: string, limit = 100): Promise<UserMessages | null> {
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
        'cm.editedAt',
        'cm.deletedAt',
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
