export const CHAT_AUDIT_FLAG = 'chat-audit-log';

/**
 * What a moderator can still resolve after a participant has tidied their own
 * view. A cleared conversation and a deleted message both stop being readable
 * in the product; without a record of the act, a `ChatReport` filed afterwards
 * points at a thread nobody can reconstruct.
 */
export const chatAuditEventTypes = ['edit', 'delete', 'clear'] as const;
export type ChatAuditEventType = (typeof chatAuditEventTypes)[number];

export type ChatAuditRow = {
  type: ChatAuditEventType;
  chatId: number;
  /** Absent for `clear`, which acts on the conversation rather than a message. */
  messageId?: number;
  /**
   * Who performed the act. Named `actorId` rather than `userId` because the
   * Tracker spreads its own actor fields into the row — a `userId` key silently
   * overwrote them.
   */
  actorId: number;
  /** Whose content it was. Differs from `actorId` on a moderator delete. */
  subjectId: number;
  /** `owner` when acting on your own, `moderator` otherwise. */
  actorRole: 'owner' | 'moderator';
  /** Empty for `clear`; for `edit` these carry the content either side of it. */
  oldValue: string;
  newValue: string;
  truncated: 0 | 1;
};

/**
 * ClickHouse rows are not the place for an unbounded message body, and the
 * moderator log renders a diff rather than a transcript.
 */
export const CHAT_AUDIT_VALUE_LIMIT = 4000;

export function truncateAuditValue(value: string) {
  return value.length > CHAT_AUDIT_VALUE_LIMIT
    ? { value: value.slice(0, CHAT_AUDIT_VALUE_LIMIT), truncated: 1 as const }
    : { value, truncated: 0 as const };
}
