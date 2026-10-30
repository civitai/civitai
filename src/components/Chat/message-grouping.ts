import { ChatMessageType } from '~/shared/utils/prisma/enums';

/** Past this, a sender starts a fresh run even if nobody else spoke in between. */
const GROUP_WINDOW_HOURS = 1;

export function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

type GroupingInput = { createdAt: Date; userId: number; contentType: ChatMessageType };

export type MessageRowFlags = {
  /** The avatar, username and time — drawn once at the head of a sender's run. */
  showHeader: boolean;
  showDayChip: boolean;
  /** A run starting against something above it, which needs space to read as new. */
  isNewSender: boolean;
};

/**
 * Resolved for the whole list rather than per row because each row's answer
 * depends on the rows before it.
 */
export function getMessageRowFlags(messages: GroupingInput[]): MessageRowFlags[] {
  let lastAt = new Date(0);
  let lastUserId = 0;

  return messages.map((message, idx) => {
    const hourDiff = (message.createdAt.valueOf() - lastAt.valueOf()) / (1000 * 60 * 60);
    const showHeader = hourDiff >= GROUP_WINDOW_HOURS || lastUserId !== message.userId;
    const showDayChip = !isSameDay(message.createdAt, lastAt);

    // An embed belongs to the message it unfurled, so it must not count as a turn:
    // advancing these would break its own sender's run and let the embed swallow
    // the day chip owed to the next real message.
    if (message.contentType !== ChatMessageType.Embed) {
      lastAt = message.createdAt;
      lastUserId = message.userId;
    }

    return { showHeader, showDayChip, isNewSender: showHeader && idx > 0 };
  });
}
