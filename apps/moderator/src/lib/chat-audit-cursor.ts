/** Keyset position in the chat audit log. `createdAt` alone is not unique, so the rest of the row
 *  breaks ties. Shared by the page (which writes it into the Older link) and its load (which reads it). */
export type ChatAuditCursor = {
  at: string;
  chatId: number;
  messageId: number;
  actorId: number;
  subjectId: number;
  type: string;
};

const CURSOR =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)_(-?\d+)_(\d+)_(-?\d+)_(-?\d+)_(edit|delete|clear|read)$/;
const isInt32 = (n: number) => Number.isSafeInteger(n) && n >= -(2 ** 31) && n < 2 ** 31;

export const formatChatAuditCursor = (c: ChatAuditCursor): string =>
  [c.at, c.chatId, c.messageId, c.actorId, c.subjectId, c.type].join('_');

/** Undefined for anything malformed, including ids out of Int32 range, which would otherwise fail the
 *  whole query rather than be ignored. */
export function parseChatAuditCursor(value: string | undefined): ChatAuditCursor | undefined {
  const m = value?.match(CURSOR);
  if (!m) return undefined;
  const [chatId, messageId, actorId, subjectId] = m.slice(2, 6).map(Number);
  if (![chatId, messageId, actorId, subjectId].every(isInt32)) return undefined;
  return { at: m[1], chatId, messageId, actorId, subjectId, type: m[6] };
}
