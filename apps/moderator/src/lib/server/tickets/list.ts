import { freshdeskTicketUrl, type Unavailable } from '../freshdesk.service';
import { getRoutedTicketContext } from '../decision-sources/support';
import { parseQuery } from '../query';
import { sentByTickets, type SentBy } from './sent-by';
import { ticketSnapshot } from './snapshot';
import type { TicketView } from '$lib/tickets/routing';
import {
  TICKET_QUERY_MULTI_KEYS,
  queryTickets,
  selectTickets,
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

/** The query string of a list page, with every bad value replaced by its default. */
export const parseTicketQuery = (url: URL): TicketListQuery =>
  parseQuery(url, ticketListQuerySchema, TICKET_QUERY_MULTI_KEYS);

/**
 * Adds what is not in the snapshot: the Freshdesk link, who sent a ticket to support, and, for a caller
 * with the PII grant, the address of a ticket whose requester the snapshot has not read. Best-effort:
 * a failed lookup leaves the field empty rather than failing the list.
 */
async function decorate(items: TicketItem[], canSeeEmail: boolean): Promise<TicketRow[]> {
  const sentBy = await sentByTickets(items.filter((t) => t.sentToSupport).map((t) => t.id));
  const emails = new Map<string, string | null>();
  const missing = canSeeEmail ? items.filter((t) => !t.requesterEmail).map((t) => t.id) : [];
  if (missing.length > 0) {
    try {
      for (const [id, c] of await getRoutedTicketContext(missing, true))
        emails.set(id, c.requesterEmail ?? null);
    } catch (e) {
      console.error('[tickets] requester address lookup failed', e);
    }
  }
  return items.map((t) => ({
    ...t,
    ...(canSeeEmail ? { requesterEmail: t.requesterEmail || (emails.get(t.id) ?? null) } : {}),
    freshdeskUrl: freshdeskTicketUrl(t.id),
    sentBy: sentBy.get(t.id) ?? null,
  }));
}

export type TicketPageResult =
  | {
      status: 'ok';
      items: TicketRow[];
      total: number;
      page: number;
      offset: number;
      hasMore: boolean;
      limit: number;
      facets: TicketFacets;
      /** The query as parsed, defaults applied, for the controls to show. */
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
  { canSeeEmail }: { canSeeEmail: boolean }
): Promise<TicketPageResult> {
  try {
    const read = await ticketSnapshot.get();
    if (read.status !== 'ok') return read;
    const page = queryTickets(read.snapshot.tickets, query, { view, canSeeEmail });
    return {
      status: 'ok',
      ...page,
      items: await decorate(page.items, canSeeEmail),
      query,
      warnings: read.warnings,
      syncedAt: read.snapshot.syncedAt,
    };
  } catch (e) {
    console.error('[tickets] list failed', e);
    return { status: 'unavailable', reason: 'The ticket list could not be read.' };
  }
}

export type TicketListResult =
  | { status: 'ok'; rows: TicketRow[]; warnings: string[] }
  | Unavailable;

/** Every live ticket of a view, newest activity first, unpaged. */
export async function listTickets(
  view: TicketView,
  { includeEmail }: { includeEmail: boolean }
): Promise<TicketListResult> {
  try {
    const read = await ticketSnapshot.get();
    if (read.status !== 'ok') return read;
    const { items } = selectTickets(read.snapshot.tickets, ticketListQuerySchema.parse({}), {
      view,
      canSeeEmail: includeEmail,
    });
    return { status: 'ok', rows: await decorate(items, includeEmail), warnings: read.warnings };
  } catch (e) {
    console.error('[tickets] list failed', e);
    return { status: 'unavailable', reason: 'The ticket list could not be read.' };
  }
}
