import { error } from '@sveltejs/kit';
import {
  freshdeskTicketUrl,
  getTicketConversation,
  getTicketDetail,
  isFreshdeskId,
  type TicketConversationResult,
} from '../freshdesk.service';
import { getRoutedTicketContext } from '../decision-sources/support';
import { sentByTickets } from './sent-by';
import { resolveUserId } from '../user-lookup.service';
import { hasSentToSupportTag, routeTicket, type TicketView } from '$lib/tickets/routing';
import { statusLabel } from '$lib/tickets/statuses';

/**
 * The view a ticket belongs to now, with the router context that decided it.
 *
 * The router's topic decides only a ticket with no feature, but its linked account helps any ticket.
 * Its failure leaves the topic unknown, which routes a feature-less ticket to support.
 */
export async function resolveTicketView(
  ticketId: string,
  ticket: { cfFeature: string | null; status: number; tags: string[] }
) {
  const routed = await getRoutedTicketContext([ticketId], false).then(
    (m) => m.get(ticketId),
    (e) => {
      console.error('[tickets] router context failed', e);
      return undefined;
    }
  );
  const routesTo = routeTicket({
    cfFeature: ticket.cfFeature,
    status: ticket.status,
    routerTopic: routed?.topic,
    tags: ticket.tags,
  });
  return { routesTo, routed };
}

/** The one ticket page behind both views' routes. */
export async function loadTicketDetail(view: TicketView, ticketId: string, locals: App.Locals) {
  if (!isFreshdeskId(ticketId)) throw error(404, 'No such ticket.');
  const canSeeEmail = !!locals.grants['decisions.support.pii'];

  const res = await getTicketDetail(ticketId);
  if (res.status !== 'found') throw error(503, res.reason);
  const { ticket } = res;

  const { routesTo, routed } = await resolveTicketView(ticketId, ticket);
  // 🔴 The page grant is per view, so a ticket opened under the wrong view would show it to a role that
  // may not open that view at all.
  if (routesTo !== view)
    throw error(
      404,
      `Ticket ${ticketId} is not a ${view} ticket; it belongs to the ${routesTo} view.`
    );

  // The address is resolved here even without the grant, and never leaves the server without it.
  let civitaiUserId = routed?.civitaiUserId ?? null;
  if (civitaiUserId === null && ticket.requesterEmail) {
    try {
      civitaiUserId = await resolveUserId(ticket.requesterEmail);
    } catch (e) {
      console.error('[tickets] user lookup failed', e);
    }
  }

  const sentToSupport = hasSentToSupportTag(ticket.tags);
  const sentBy = sentToSupport ? (await sentByTickets([ticketId])).get(ticketId) ?? null : null;

  const conversation: Promise<TicketConversationResult> = getTicketConversation(ticketId).catch(
    () => ({ status: 'unavailable' as const, reason: 'Freshdesk could not be read.' })
  );

  return {
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      statusLabel: statusLabel(ticket.status),
      cfFeature: ticket.cfFeature,
      routerTopic: routed?.topic ?? null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      freshdeskUrl: freshdeskTicketUrl(ticket.id),
      description: ticket.description,
      requesterName: ticket.requesterName,
      ...(canSeeEmail ? { requesterEmail: ticket.requesterEmail } : {}),
      civitaiUserId,
      sentToSupport,
      sentBy,
    },
    view,
    canReply: !!locals.grants['tickets.reply'],
    canEscalate: view === 'moderation' && !!locals.grants['tickets.escalate'],
    // Not awaited: SvelteKit streams it, so a slow conversation read delays that panel, not the page.
    conversation,
  };
}
