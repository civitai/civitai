import { ACCOUNT_RESTRICTION_FEATURE, type TicketView } from './routing';

/** Router topics that mean the ticket is about the sender's account. Edit to add one. */
export const ACCOUNT_TOPICS: readonly string[] = ['account-issue'];

export type AccountPanel = 'panel' | 'unlinked' | 'hidden';

/** Only moderation-view tickets about an account qualify; one with no linked user gets a note, not a panel. */
export function accountPanelFor(ticket: {
  view: TicketView;
  cfFeature: string | null | undefined;
  routerTopic: string | null | undefined;
  civitaiUserId: number | null;
}): AccountPanel {
  if (ticket.view !== 'moderation') return 'hidden';
  const aboutAccount =
    ticket.cfFeature?.trim() === ACCOUNT_RESTRICTION_FEATURE ||
    (!!ticket.routerTopic && ACCOUNT_TOPICS.includes(ticket.routerTopic));
  if (!aboutAccount) return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
