import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { usersByIds } from './users.service';

// The `chatAuditEvents` log, for the Chat Audit Log page: edits, deletes and clears by participants and
// moderators, and every moderator read of a conversation. Metadata only — never `oldValue`/`newValue`.
// Those are message bodies, and showing them here would let this page read DMs without the read itself
// being logged; the transcript behind the link shows them and records the read.

export const chatAuditEventTypes = ['edit', 'delete', 'clear', 'read'] as const;
export type ChatAuditEventType = (typeof chatAuditEventTypes)[number];

import type { ChatAuditCursor } from '$lib/chat-audit-cursor';

export type ChatAuditEvent = {
  /** ISO. */
  at: string;
  type: string;
  chatId: number;
  /** 0 for events on the conversation rather than a message (`clear`, `read`). */
  messageId: number;
  actorId: number;
  actorName: string | null;
  /** 0 when the event is not about one account's content. */
  subjectId: number;
  subjectName: string | null;
  actorRole: string;
  cursor: ChatAuditCursor;
};

export type ChatAuditFilter = {
  chatId?: number;
  actorId?: number;
  type?: ChatAuditEventType;
  before?: ChatAuditCursor;
};

type Row = {
  createdAt: string;
  type: string;
  chatId: number;
  messageId: number;
  actorId: number;
  subjectId: number;
  actorRole: string;
};

export async function getChatAuditEvents(
  filter: ChatAuditFilter,
  limit: number
): Promise<{ events: ChatAuditEvent[]; next: ChatAuditCursor | null }> {
  const where = [
    filter.chatId !== undefined && 'chatId = {chatId:Int32}',
    filter.actorId !== undefined && 'actorId = {actorId:Int32}',
    filter.type && 'type = {type:String}',
    filter.before &&
      '(createdAt, chatId, messageId, actorId, subjectId, type) < ({at:DateTime64(3)}, {bChat:Int32}, {bMessage:Int32}, {bActor:Int32}, {bSubject:Int32}, {bType:String})',
  ].filter(Boolean);

  const result = await getClickhouse().query({
    query: `
      SELECT toString(createdAt) AS createdAt, type, chatId, messageId, actorId, subjectId, actorRole
      FROM default.chatAuditEvents
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY createdAt DESC, chatId DESC, messageId DESC, actorId DESC, subjectId DESC, type DESC
      LIMIT {limit:UInt32}
    `,
    // The client sends an undefined param as NULL rather than omitting it.
    query_params: Object.fromEntries(
      Object.entries({
        chatId: filter.chatId,
        actorId: filter.actorId,
        type: filter.type,
        at: filter.before?.at,
        bChat: filter.before?.chatId,
        bMessage: filter.before?.messageId,
        bActor: filter.before?.actorId,
        bSubject: filter.before?.subjectId,
        bType: filter.before?.type,
        limit: limit + 1,
      }).filter(([, v]) => v !== undefined)
    ),
    format: 'JSONEachRow',
  });
  const rows = await result.json<Row>();

  const page = rows.slice(0, limit);
  const names = await usersByIds(page.flatMap((r) => [Number(r.actorId), Number(r.subjectId)]));
  const events = page.map((r) => {
    const cursor = {
      at: r.createdAt,
      chatId: Number(r.chatId),
      messageId: Number(r.messageId),
      actorId: Number(r.actorId),
      subjectId: Number(r.subjectId),
      type: r.type,
    };
    return {
      at: clickhouseDate(r.createdAt),
      type: r.type,
      chatId: cursor.chatId,
      messageId: cursor.messageId,
      actorId: cursor.actorId,
      actorName: names.get(cursor.actorId)?.username ?? null,
      subjectId: cursor.subjectId,
      subjectName: names.get(cursor.subjectId)?.username ?? null,
      actorRole: r.actorRole,
      cursor,
    };
  });

  return { events, next: rows.length > limit ? events[events.length - 1].cursor : null };
}
