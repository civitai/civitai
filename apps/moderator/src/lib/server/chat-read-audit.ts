import { logAxiomError } from './axiom';
import { getClickhouse } from './clickhouse';
import { dbRead } from './db';

/** One conversation a moderator was shown message bodies from. `subjectId` is whose messages they were
 *  when the read was of one account's messages, 0 when it was of the whole conversation. */
/** The moderator doing the reading. Branded so a chat or account id cannot be passed in its place:
 *  every signature here takes both, and a swap would record the wrong person as the reader. */
export type Reader = number & { readonly __reader: true };
export const readerOf = (user: { id: number }) => user.id as Reader;

export type ChatRead = { chatId: number; subjectId?: number };

const READ_AUDIT_TIMEOUT_MS = 2_000;

/**
 * Records that a moderator read someone's private messages, in the same `chatAuditEvents` log the main
 * app's moderator thread writes to, so both apps keep one trail. One row per chat per read: no dedupe.
 *
 * Fails OPEN. A ClickHouse outage must not stop moderators working, so a failed or stalled write is
 * logged and the read goes ahead. The client inserts asynchronously without waiting for the flush, so a
 * failure on the server's side of the flush is not seen here.
 */
export async function recordChatReads(actorId: Reader, reads: ChatRead[]): Promise<void> {
  if (!reads.length) return;
  try {
    await getClickhouse().insert({
      table: 'chatAuditEvents',
      values: reads.map(({ chatId, subjectId = 0 }) => ({
        type: 'read',
        chatId,
        messageId: 0,
        actorId,
        subjectId,
        actorRole: 'moderator',
        oldValue: '',
        newValue: '',
        truncated: 0,
      })),
      format: 'JSONEachRow',
      // The shared client waits minutes per request; a stalled server must not hold the read that long.
      abort_signal: AbortSignal.timeout(READ_AUDIT_TIMEOUT_MS),
    });
  } catch (error) {
    void logAxiomError(error, {
      event: 'chat-read-audit-failed',
      chatIds: reads.map((r) => r.chatId),
      actorId,
    });
  }
}

/** For a surface that loads messages by id alone: a read of each message's chat, attributed to its sender. */
export async function recordChatMessageReads(actorId: Reader, messageIds: number[]): Promise<void> {
  if (!messageIds.length) return;
  const rows = await dbRead
    .selectFrom('ChatMessage')
    .select(['chatId', 'userId'])
    .where('id', 'in', messageIds)
    .execute();
  await recordChatReads(
    actorId,
    [...new Map(rows.map((r) => [`${r.chatId}:${r.userId}`, r])).values()].map((r) => ({
      chatId: r.chatId,
      subjectId: r.userId,
    }))
  );
}
