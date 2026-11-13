import { freshdeskTicketUrl, type Unavailable } from '../freshdesk.service';
import { parseQuery } from '../query';
import { sentByTickets, type SentBy } from './sent-by';
import { ticketSnapshot } from './snapshot';
import type { TicketView } from '$lib/tickets/routing';
import {
  TICKET_QUERY_MULTI_KEYS,
  findTicket,
  queryTickets,
  ticketListQuerySchema,
  type TicketFacets,
  type TicketItem,
  type TicketListQuery,
} from '$lib/tickets/view-query';

export type TicketRow = TicketItem & {
  freshdeskUrl: string;
  /** Who sent it, when ModActivity has the row; a ticket tagged by hand has none. */
  sentBy: SentBy | null;
};

export const parseTicketQuery = (url: URL): TicketListQuery =>
  parseQuery(url, ticketListQuerySchema, TICKET_QUERY_MULTI_KEYS);

/** Adds the Freshdesk link and "sent by". The sent-by lookup is best-effort: on failure rows show none and the page warns. The requester's address is never part of a row. */
async function decorator(items: TicketItem[]) {
  let sentBy = new Map<string, SentBy>();
  const tagged = items.filter((t) => t.sentToSupport).map((t) => t.id);
  let warning: string | null = null;
  if (tagged.length > 0) {
    try {
      sentBy = await sentByTickets(tagged);
    } catch (e) {
      console.error('[tickets] sent-by lookup failed', e);
      warning = 'Who sent tickets to support could not be read, so "Sent by" is not shown.';
    }
  }
  return {
    warning,
    row: (t: TicketItem): TicketRow => ({
      ...t,
      freshdeskUrl: freshdeskTicketUrl(t.id),
      sentBy: sentBy.get(t.id) ?? null,
    }),
  };
}

export type TicketPageResult =
  | {
      status: 'ok';
      items: TicketRow[];
      pinned: TicketRow | null;
      total: number;
      page: number;
      offset: number;
      hasMore: boolean;
      limit: number;
      facets: TicketFacets;
      query: TicketListQuery;
      /** Parts of the data that are incomplete or degraded, to be shown above the list. */
      warnings: string[];
      /** Epoch ms the data was last read from Freshdesk. */
      syncedAt: number;
    }
  | Unavailable;

/**
 * One page of a view, filtered, searched and sorted from the shared snapshot. Never throws, and waits on
 * Freshdesk only when no snapshot exists yet.
 */
export async function loadTicketPage(
  view: TicketView,
  query: TicketListQuery,
  { pinnedId }: { pinnedId?: string }
): Promise<TicketPageResult> {
  try {
    const read = await ticketSnapshot.get();
    if (read.status !== 'ok') return read;
    const context = { view };
    const page = queryTickets(read.snapshot.tickets, query, context);
    const offPage =
      pinnedId && !page.items.some((t) => t.id === pinnedId)
        ? findTicket(read.snapshot.tickets, pinnedId, context)
        : null;
    const { row, warning } = await decorator(offPage ? [...page.items, offPage] : page.items);
    return {
      status: 'ok',
      ...page,
      items: page.items.map(row),
      pinned: offPage ? row(offPage) : null,
      query,
      warnings: warning ? [...read.warnings, warning] : read.warnings,
      syncedAt: read.snapshot.syncedAt,
    };
  } catch (e) {
    console.error('[tickets] list failed', e);
    return { status: 'unavailable', reason: 'The ticket list could not be read.' };
  }
}
