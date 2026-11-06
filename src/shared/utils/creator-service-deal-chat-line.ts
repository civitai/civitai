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
