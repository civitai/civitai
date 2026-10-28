import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { escapeLike } from './like';
import { SYSTEM_USER_ID, isInt4Id, usernameExists } from './users.service';
import { recordChatReads, type Reader } from './chat-read-audit';

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
  /** Who wrote it, when it was sent as Civitai Moderation. */
  sentBy?: string | null;
  content: string;
  /** Set when the sender rewrote the message. An edit overwrites `content`, so earlier versions come
   *  from the edit history instead; see `getRecordedEdits` and `getMessageEdits`. */
  editedAt: Date | null;
  /** Deleted messages are hidden from both participants but retained for exactly this. A report is
   *  usually filed about a message the sender then removed, so omitting them hid the evidence. */
  deletedAt: Date | null;
};

/**
 * ONE edit, from `ChatMessageEdit` or, for edits before it shipped, the `chatAuditEvents` log.
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

export async function searchChats(reader: Reader, rawTerm: string): Promise<ChatSearch | null> {
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
    chats: ids.length ? await summariseChats(reader, ids, mode, term) : [],
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

/**
 * Each chat's message count and latest message — Chat Audit's list and the chat report queue's rows, so
 * the two never disagree about the same chat. (chatId, id) is indexed, so each is an index range.
 *
 * System rows are 14% of the table, and 51,245 chats contain nothing else — counting them made an
 * empty conversation read as "1 messages", and disagreed with the transcript, which leaves them out.
 */
export async function chatMessageCounts(
  chatIds: number[]
): Promise<Map<number, { messages: number; lastAt: Date | null }>> {
  if (!chatIds.length) return new Map();
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
  return new Map(
    counts.map((c) => [c.chatId, { messages: Number(c.messages), lastAt: c.lastAt ?? null }])
  );
}

// Retool's FindChats joined member names with string_agg and split on ',', which corrupts any username
// containing a comma. A real array avoids inventing a delimiter.
async function summariseChats(
  reader: Reader,
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

  const byChat = await chatMessageCounts(chatIds);
  const excerpts = await chatExcerpts(chatIds, mode, term);
  await recordChatReads(
    reader,
    [...excerpts].map(([chatId, e]) => ({ chatId, subjectId: e.userId }))
  );

  return rows
    .map((r) => ({
      chatId: r.chatId,
      ownerId: r.ownerId,
      owner: r.owner,
      ownerBannedAt: r.ownerBannedAt,
      members: r.members ?? [],
      messages: byChat.get(r.chatId)?.messages ?? 0,
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

// The read every message list starts from: one chat's messages with their sender, system rows left out
// and deleted ones kept (see `getTranscript`). Callers add their own ordering, range and limit.
const chatMessageRead = (chatId: number) =>
  dbRead
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
      // The moderator behind a Civitai Moderation message; the user only ever saw that account.
      (eb) =>
        eb
          .selectFrom('ModActivity as ma')
          .innerJoin('User as mu', 'mu.id', 'ma.userId')
          .select('mu.username')
          .where('ma.entityType', '=', 'chatMessage')
          .where('ma.activity', '=', 'message-as-civitai')
          .whereRef('ma.entityId', '=', 'cm.id')
          .orderBy('ma.id')
          .limit(1)
          .as('sentBy'),
    ])
    .where('cm.chatId', '=', chatId)
    .where('cm.userId', '!=', SYSTEM_USER_ID);

// The transcript. Chat-scoped, so it rides the (chatId, id) index.
//
// System rows are excluded: 274,106 of them are `contentType = 'Embed'` whose content is a raw JSON
// blob, which rendered verbatim attributed to "civitai" and ate slots in the cap.
//
// Deleted rows are INCLUDED. `deletedAt` hides a message from both participants and keeps the row for
// moderation, so a report filed about a message the sender then removed pointed at a transcript that
// did not contain it.
export async function getTranscript(
  reader: Reader,
  chatId: number,
  limit = 300
): Promise<{
  rows: ChatMessageRow[];
  truncated: boolean;
  /** Every edit per message, oldest first. */
  edits: Record<number, MessageEdit[]>;
  /** A history source could not be read, so a message may have more versions than `edits` holds — and
   *  one with none is unknown, not unrecorded. */
  editsPartial: boolean;
}> {
  if (!isInt4Id(chatId)) return { rows: [], truncated: false, edits: {}, editsPartial: false };

  const rows = await chatMessageRead(chatId)
    // Newest first so the cap drops the OLDEST; reversed here for reading order.
    .orderBy('cm.createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const edited = page.filter((r) => r.editedAt);
  if (page.length) await recordChatReads(reader, [{ chatId }]);

  const [recorded, logged] = await Promise.all([
    getRecordedEdits(edited),
    getMessageEdits(
      chatId,
      edited.map((r) => r.id)
    ),
  ]);
  return {
    rows: page,
    truncated,
    edits: mergeEdits(recorded ?? {}, logged ?? {}),
    editsPartial: recorded === null || logged === null,
  };
}

/** Per transcript, across all its messages. */
const RECORDED_EDITS_CAP = 5_000;

/**
 * Edits from `ChatMessageEdit`, written in the same statement as the edit. Each row holds the text it
 * replaced; the text it left is the next row's, or the message's current content.
 */
async function getRecordedEdits(
  messages: Pick<ChatMessageRow, 'id' | 'userId' | 'content'>[]
): Promise<Record<number, MessageEdit[]> | null> {
  if (!messages.length) return {};

  try {
    const rows = await dbRead
      .selectFrom('ChatMessageEdit')
      .select(['messageId', 'editorId', 'previousContent', 'createdAt'])
      .where(
        'messageId',
        'in',
        messages.map((m) => m.id)
      )
      .orderBy('id', 'asc')
      .limit(RECORDED_EDITS_CAP + 1)
      .execute();
    // Edits are not rate-limited, so one message can carry any number of them. Over the cap the
    // transcript shows none rather than an arbitrary subset, and says the history is incomplete.
    if (rows.length > RECORDED_EDITS_CAP) return null;

    const byId = new Map(messages.map((m) => [m.id, m]));
    const byMessage: Record<number, MessageEdit[]> = {};
    for (const r of rows) {
      const message = byId.get(r.messageId);
      if (!message) continue;
      const chain = (byMessage[r.messageId] ??= []);
      const prev = chain.at(-1);
      if (prev) prev.newValue = r.previousContent;
      chain.push({
        at: new Date(r.createdAt).toISOString(),
        oldValue: r.previousContent,
        newValue: message.content,
        truncated: false,
        actorRole: r.editorId === message.userId ? 'owner' : 'moderator',
      });
    }
    return byMessage;
  } catch (e) {
    // The moderator app can deploy before the table's migration is applied.
    console.error('[chat-audit] recorded message edits unavailable', e);
    return null;
  }
}

/** First index whose value is at least `min`, in an ascending list. */
function lowerBound(sorted: number[], min: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Recorded edits keep their own order, which is the order the row lock let them through: their
 * timestamps are taken before the lock, so two racing edits can be stamped the other way round.
 * Logged-only edits are slotted in by time around them.
 */
function interleave(logged: MessageEdit[], recorded: MessageEdit[]): MessageEdit[] {
  const out: MessageEdit[] = [];
  let i = 0;
  for (const r of recorded) {
    while (i < logged.length && Date.parse(logged[i].at) <= Date.parse(r.at)) out.push(logged[i++]);
    out.push(r);
  }
  return [...out, ...logged.slice(i)];
}

/** The same edit lands in both sources, its ClickHouse row inserted just after the Postgres one; the
 *  small lead allowed the other way is clock skew between the app and ClickHouse. */
const SAME_EDIT_WINDOW_MS = 60_000;
const SAME_EDIT_SKEW_MS = 5_000;

/**
 * Postgres history starts when it shipped; the ClickHouse log reaches further back while its flag was on.
 * A logged edit that matches a recorded one (same text either side, moments apart) is that edit, so it is
 * dropped; the rest are earlier edits only the log saw.
 */
export function mergeEdits(
  recorded: Record<number, MessageEdit[]>,
  logged: Record<number, MessageEdit[]>
): Record<number, MessageEdit[]> {
  const merged: Record<number, MessageEdit[]> = {};
  for (const id of new Set([...Object.keys(recorded), ...Object.keys(logged)].map(Number))) {
    const rec = recorded[id] ?? [];
    const log = logged[id] ?? [];
    // Closest pairs first, so text that goes back and forth inside the window pairs each logged edit
    // with its own recorded one rather than whichever came first.
    const byTime = rec
      .map((r, ri) => ({ r, ri, at: Date.parse(r.at) }))
      .sort((a, b) => a.at - b.at);
    const times = byTime.map((x) => x.at);
    const pairs: { li: number; ri: number; gap: number }[] = [];
    log.forEach((l, li) => {
      const at = Date.parse(l.at);
      // Only the recorded edits inside the window are compared.
      for (let k = lowerBound(times, at - SAME_EDIT_WINDOW_MS); k < byTime.length; k++) {
        const { r, ri } = byTime[k];
        const lag = at - times[k];
        if (lag <= -SAME_EDIT_SKEW_MS) break;
        if (lag < SAME_EDIT_WINDOW_MS && r.oldValue === l.oldValue && r.newValue === l.newValue)
          pairs.push({ li, ri, gap: Math.abs(lag) });
      }
    });
    pairs.sort((a, b) => a.gap - b.gap);
    const dropped = new Set<number>();
    const taken = new Set<number>();
    for (const { li, ri } of pairs) {
      if (dropped.has(li) || taken.has(ri)) continue;
      dropped.add(li);
      taken.add(ri);
    }
    const onlyLogged = log.filter((_, li) => !dropped.has(li));
    merged[id] = interleave(onlyLogged, rec);
  }
  return merged;
}

/** Messages shown above the oldest held one and below the newest held one. */
export const CHAT_WINDOW_BEFORE = 10;
export const CHAT_WINDOW_AFTER = 5;
/** Bounds the span between the first and last held message, which is one sender's 24-hour window. */
const CHAT_WINDOW_SPAN_CAP = 200;

export type ChatWindow = {
  rows: ChatMessageRow[];
  /** Messages from the first judged one up to the first row shown, left out of a span over the cap. */
  omitted: number;
};

/**
 * The conversation around a set of held messages, oldest first: every message from the first to the
 * last held id, plus `before` earlier and `after` later ones. Keyset reads on `(chatId, id)`, so the
 * cost follows the window, not the chat. System rows are excluded and deleted rows kept, as in
 * `getTranscript`. Ids that are not in the chat anchor nothing. A span over the cap keeps its newest
 * rows and the earlier context is read from where the kept ones start, so what is left out is counted
 * in `omitted` and never hidden as a gap.
 */
export async function getChatWindow(
  chatId: number,
  ids: number[],
  before = CHAT_WINDOW_BEFORE,
  after = CHAT_WINDOW_AFTER
): Promise<ChatWindow> {
  const none = { rows: [], omitted: 0 };
  const requested = ids.filter(isInt4Id);
  if (!isInt4Id(chatId) || !requested.length) return none;

  const read = () => chatMessageRead(chatId);

  const anchors = (await read().where('cm.id', 'in', requested).execute()).map((row) => row.id);
  if (!anchors.length) return none;
  const first = Math.min(...anchors);
  const last = Math.max(...anchors);

  const newestSpan = await read()
    .where('cm.id', '>=', first)
    .where('cm.id', '<=', last)
    .orderBy('cm.id', 'desc')
    .limit(CHAT_WINDOW_SPAN_CAP + 1)
    .execute();
  const span = newestSpan.slice(0, CHAT_WINDOW_SPAN_CAP);
  const spanStart = span[span.length - 1].id;

  const [earlier, later] = await Promise.all([
    read().where('cm.id', '<', spanStart).orderBy('cm.id', 'desc').limit(before).execute(),
    read().where('cm.id', '>', last).orderBy('cm.id', 'asc').limit(after).execute(),
  ]);

  const shownFrom = earlier.length ? earlier[earlier.length - 1].id : spanStart;
  const omitted =
    newestSpan.length > CHAT_WINDOW_SPAN_CAP && shownFrom > first
      ? Number(
          (
            await read()
              .where('cm.id', '>=', first)
              .where('cm.id', '<', shownFrom)
              .clearSelect()
              .select((eb) => eb.fn.countAll().as('n'))
              .executeTakeFirstOrThrow()
          ).n
        )
      : 0;

  return { rows: [...earlier.reverse(), ...span.reverse(), ...later], omitted };
}

/** The held sender's judged messages alone, for a moderator who may not read the rest of the chat. */
export async function getJudgedMessages(
  chatId: number,
  ids: number[],
  senderId: number | null
): Promise<ChatMessageRow[]> {
  const requested = ids.filter(isInt4Id);
  if (!isInt4Id(chatId) || senderId === null || !isInt4Id(senderId) || !requested.length) return [];

  return chatMessageRead(chatId)
    .where('cm.userId', '=', senderId)
    .where('cm.id', 'in', requested)
    .orderBy('cm.id', 'asc')
    .execute();
}

/**
 * Edits from the `chatAuditEvents` ClickHouse log, the only record of those made before
 * `ChatMessageEdit` existed. Best-effort: the log being down must not take the transcript with it.
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
/** One account's messages span many chats: a read of each chat they appear in, attributed to them. */
const recordUserMessageReads = (reader: Reader, rows: ChatMessageWithChat[]) =>
  recordChatReads(
    reader,
    [...new Map(rows.map((r) => [r.chatId, r.userId])).entries()].map(([chatId, subjectId]) => ({
      chatId,
      subjectId,
    }))
  );

export async function getUserMessagesById(
  reader: Reader,
  userId: number,
  limit = 50
): Promise<UserMessages> {
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

  const page = rows.slice(0, limit);
  await recordUserMessageReads(reader, page);
  return { truncated: rows.length > limit, chats: Number(distinct?.n ?? 0), rows: page };
}

export async function getUserMessages(
  reader: Reader,
  username: string,
  limit = 100
): Promise<UserMessages | null> {
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

  const page = rows.slice(0, limit);
  await recordUserMessageReads(reader, page);
  return { truncated: rows.length > limit, chats: Number(distinct?.n ?? 0), rows: page };
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
