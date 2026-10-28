import {
  freshdeskTicketUrl,
  searchTickets,
  type TicketSummary,
  type Unavailable,
} from '../freshdesk.service';
import { sentByTickets, type SentBy } from './sent-by';
import { createLoadCache, readAll, shortReadWarning, type Budget, type Searched } from './search';
import { getRoutedTicketContext, type RoutedTicketContext } from '../decision-sources/support';
import { moderationQuery, statusQuery, unclassifiedQuery } from '$lib/tickets/queries';
import { hasSentToSupportTag, routeTicket, type TicketView } from '$lib/tickets/routing';
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
  /** Carries the sent-to-support tag. */
  sentToSupport: boolean;
  /** Who sent it, when ModActivity has the row; a ticket tagged by hand has none. */
  sentBy: SentBy | null;
};

export type TicketListResult =
  | {
      status: 'ok';
      rows: TicketRow[];
      /** Parts of the list that are incomplete or degraded, to be shown above it. */
      warnings: string[];
    }
  | Unavailable;

/** Freshdesk calls one list load may make. The support view reads about 800 tickets at 30 a page, and
 *  a status over the 300-result ceiling costs extra requests to split by day. */
const CALL_BUDGET = 80;

/** Searches are shared by everyone on the view and the account's rate limit is shared by everyone on
 *  Freshdesk, so a burst of page loads reads one answer. Only complete reads are kept. */
const cached = createLoadCache<Searched>(30_000, (r) => r.status === 'ok' && r.complete);

const today = () => new Date().toISOString().slice(0, 10);

const searchAll = (expression: string, budget: Budget): Promise<Searched> =>
  cached(expression, () => readAll(expression, searchTickets, budget, today()));

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
 * each live status and filters here. One search yields at most 300 tickets, so a bigger one is
 * split by creation day (see `readAll`); a read that is still short is reported in `warnings` instead
 * of passing as the whole list.
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
    const budget: Budget = { left: CALL_BUDGET };
    // Sequential: the support view issues a few dozen requests against a shared rate limit.
    for (const { label, expression } of searchesFor(view)) {
      const res = await searchAll(expression, budget);
      if (res.status !== 'ok') return res;
      for (const t of res.tickets) found.set(t.id, t);
      if (res.failedRequests > 0)
        warnings.push(
          `${res.failedRequests} Freshdesk request(s) failed while reading ${label}, so some are missing from this list. Reload to retry.`
        );
      else if (!res.complete) warnings.push(shortReadWarning(label, res));
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

    const visible = [...found.values()].filter(
      (t) =>
        routeTicket({
          cfFeature: t.cfFeature,
          status: t.status,
          routerTopic: context.get(t.id)?.topic,
          tags: t.tags,
        }) === view
    );
    // Only the support view shows who sent a ticket, and only tagged tickets can have been sent.
    const sentBy =
      view === 'support'
        ? await sentByTickets(visible.filter((t) => hasSentToSupportTag(t.tags)).map((t) => t.id))
        : new Map<string, SentBy>();

    const rows = visible
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
          sentToSupport: hasSentToSupportTag(t.tags),
          sentBy: sentBy.get(t.id) ?? null,
        };
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { status: 'ok', rows, warnings };
  } catch (e) {
    console.error('[tickets] list failed', e);
    return { status: 'unavailable', reason: 'The ticket list could not be read.' };
  }
}
