import { routeTicket, type TicketView } from './routing';
import type { Snapshot } from './snapshot';

export const TICKET_COUNT_KEYS: Record<TicketView, string> = {
  moderation: 'ticketsModeration',
  support: 'ticketsSupport',
};

/** Live tickets per view, keyed for the sidebar. No snapshot, no counts: a badge is absent, not zero. */
export function countTicketViews(snapshot: Snapshot | null): Record<string, number> {
  if (!snapshot) return {};
  const counts: Record<string, number> = {
    [TICKET_COUNT_KEYS.moderation]: 0,
    [TICKET_COUNT_KEYS.support]: 0,
  };
  for (const t of snapshot.tickets) {
    counts[
      TICKET_COUNT_KEYS[
        routeTicket({
          cfFeature: t.cfFeature,
          status: t.status,
          routerTopic: t.routerTopic,
          tags: t.tags,
        })
      ]
    ]++;
  }
  return counts;
}
