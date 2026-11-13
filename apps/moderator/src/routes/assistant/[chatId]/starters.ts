/** The first question a chat opened from an Investigate button offers, for the moderator to edit. */
export function starterPrompt(chat: {
  seedUserId: number | null;
  seedReportId: number | null;
}): string {
  if (chat.seedReportId && chat.seedUserId)
    return `Look into report [report:${chat.seedReportId}] about [user:${chat.seedUserId}]. Is there anything here I should act on? Check the account, the accounts linked to it, and whether the report's claim holds up.`;
  if (chat.seedUserId)
    return `Look into [user:${chat.seedUserId}]. Is there anything here I should act on? Check the account and the accounts linked to it.`;
  return '';
}
