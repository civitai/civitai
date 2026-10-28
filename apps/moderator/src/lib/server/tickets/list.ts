import {
  SEARCH_MAX_PAGES,
  SEARCH_PAGE_SIZE,
  freshdeskTicketUrl,
  searchTickets,
  type TicketSummary,
  type Unavailable,
} from '../freshdesk.service';
import { getRoutedTicketContext, type RoutedTicketContext } from '../decision-sources/support';
import { moderationQuery, statusQuery, unclassifiedQuery } from '$lib/tickets/queries';
import { routeTicket, type TicketView } from '$lib/tickets/routing';
import { LIVE_STATUSES, statusLabel } from '$lib/tickets/statuses';

export type TicketRow = {
  id: string;
  subject: string;
  status: number;
  statusLabel: string;
  cfFeature: string | null;
  routerTopic: string | null;
  civitaiUserId: number | null;
  /** Present only for a caller holding the PII grant. */
  requesterEmail?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  freshdeskUrl: string;
};

export type TicketListResult =
  | {
      status: 'ok';
      rows: TicketRow[];
      /** Parts of the list that are incomplete or degraded, to be shown above it. */
      warnings: string[];
    }
  | Unavailable;

type Searched =
  | { status: 'ok'; tickets: TicketSummary[]; total: number; truncated: boolean }
  | Unavailable;

/** Searches are shared by everyone on the view and the account's rate limit is shared by everyone on
 *  Freshdesk, so a burst of page loads reads one answer. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<Searched> }>();

/** Every page of one search expression, up to Freshdesk's 300-result ceiling. */
async function readAll(expression: string): Promise<Searched> {
  const first = await searchTickets(expression, 1);
  if (first.status !== 'ok') return first;
  const pages = Math.min(SEARCH_MAX_PAGES, Math.ceil(first.total / SEARCH_PAGE_SIZE));
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => searchTickets(expression, i + 2))
  );
  const tickets = [...first.tickets];
  for (const page of rest) {
    if (page.status !== 'ok') return page;
    tickets.push(...page.tickets);
  }
  return { status: 'ok', tickets, total: first.total, truncated: first.total > tickets.length };
}

function searchAll(expression: string): Promise<Searched> {
  const hit = cache.get(expression);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = readAll(expression);
  cache.set(expression, { at: Date.now(), value });
  // A failure must not be served for 30 seconds.
  void value.then((v) => v.status !== 'ok' && cache.delete(expression));
  return value;
}

/** What each view reads, with how to describe a read that came back short. */
const searchesFor = (view: TicketView): { label: string; expression: string }[] =>
  view === 'moderation'
    ? [
        { label: 'moderation tickets', expression: moderationQuery() },
        { label: 'tickets without a feature', expression: unclassifiedQuery() },
      ]
    : LIVE_STATUSES.map((s) => ({
        label: `"${statusLabel(s)}" tickets`,
        expression: statusQuery(s),
      }));

/**
 * The live tickets of one view, newest activity first.
 *
 * Freshdesk is the source of truth; the router's topic only decides tickets that have no `cf_feature`.
 * The moderation view asks Freshdesk for its own sets directly (about 150 of ~800 live tickets). The
 * support view is "everything live that is not moderation", which no search can express, so it reads
 * each live status and filters here. One search yields at most 300 tickets, and a short read is
 * reported in `warnings` instead of passing as the whole list.
 *
 * Never throws.
 */
export async function listTickets(
  view: TicketView,
  { includeEmail }: { includeEmail: boolean }
): Promise<TicketListResult> {
  try {
    const found = new Map<string, TicketSummary>();
    const warnings: string[] = [];
    // Sequential: the support view issues a few dozen requests against a shared rate limit.
    for (const { label, expression } of searchesFor(view)) {
      const res = await searchAll(expression);
      if (res.status !== 'ok') return res;
      for (const t of res.tickets) found.set(t.id, t);
      if (res.truncated)
        warnings.push(
          `Showing the first ${res.tickets.length} of ${res.total} ${label}; the rest is in Freshdesk.`
        );
    }

    let context = new Map<string, RoutedTicketContext>();
    try {
      context = await getRoutedTicketContext([...found.keys()], includeEmail);
    } catch (e) {
      console.error('[tickets] router context failed', e);
      warnings.push(
        'The ticket router could not be read, so tickets without a feature are shown in the support view whatever they are about.'
      );
    }

    const rows = [...found.values()]
      .map((t): TicketRow => {
        const routed = context.get(t.id);
        return {
          id: t.id,
          subject: t.subject,
          status: t.status,
          statusLabel: statusLabel(t.status),
          cfFeature: t.cfFeature,
          routerTopic: routed?.topic ?? null,
          civitaiUserId: routed?.civitaiUserId ?? null,
          ...(includeEmail ? { requesterEmail: routed?.requesterEmail ?? null } : {}),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          freshdeskUrl: freshdeskTicketUrl(t.id),
        };
      })
      .filter(
        (r) =>
          routeTicket({ cfFeature: r.cfFeature, status: r.status, routerTopic: r.routerTopic }) ===
          view
      )
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { status: 'ok', rows, warnings };
  } catch (e) {
    console.error('[tickets] list failed', e);
    return { status: 'unavailable', reason: 'The ticket list could not be read.' };
  }
}
