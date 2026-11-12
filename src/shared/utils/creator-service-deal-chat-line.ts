const MARKDOWN_CHARS = /[\\*_[\]`]/g;

/** The one system line both parties see when a deal opens its chat, so it names the seller, not "you". */
export function dealAcceptedChatLine({
  dealId,
  sellerName,
  title,
}: {
  dealId: number;
  sellerName: string | null;
  title: string;
}) {
  const cleanTitle = title.replace(MARKDOWN_CHARS, '');
  const owner = sellerName ? `${sellerName.replace(MARKDOWN_CHARS, '')}'s service` : 'the service';
  const stop = /[.!?]$/.test(cleanTitle) ? '' : '.';
  return `Deal accepted: ${owner} **${cleanTitle}**${stop} [Open the deal](/services/deals/${dealId})`;
}

/**
 * Posted when the overdue sweep cancels a deal, so both parties see why when they open the chat. A
 * revision round was cancelled for the undelivered revision, not for missing the due date.
 */
export function dealOverdueCancelledChatLine({
  dealId,
  days,
  revision,
}: {
  dealId: number;
  days: number;
  revision: boolean;
}) {
  const why = revision
    ? `the requested revision wasn't delivered within ${days} days`
    : `nothing was delivered within ${days} days of the due date`;
  return `This deal was cancelled automatically because ${why}. The buyer's Buzz has been refunded. [Open the deal](/services/deals/${dealId})`;
}
