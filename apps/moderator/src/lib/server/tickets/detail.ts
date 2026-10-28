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
import { ticketSnapshot, toRecord } from './snapshot';
import { resolveUserId } from '../user-lookup.service';
import { hasSentToSupportTag, routeTicket, type TicketView } from '$lib/tickets/routing';
import { topicIsKnown, type TicketRecord } from '$lib/tickets/snapshot';
import { statusLabel } from '$lib/tickets/statuses';

/**
 * The view a ticket belongs to now, with the router context that decided it. `known` is the snapshot's copy:
 * its router answer stands in for a lookup while it is current. A router failure leaves the topic unknown.
 */
export async function resolveTicketView(
  ticketId: string,
  ticket: { cfFeature: string | null; status: number; tags: string[] },
  known?: TicketRecord
) {
  const routed =
    known && topicIsKnown(known, Date.now())
      ? { topic: known.routerTopic ?? null, civitaiUserId: known.civitaiUserId ?? null }
      : await getRoutedTicketContext([ticketId], false).then(
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

  // The ticket was just read from Freshdesk, so the snapshot takes its copy; what it held before supplies the router answer.
  const known = await ticketSnapshot.patch(toRecord(ticket));
  const { routesTo, routed } = await resolveTicketView(ticketId, ticket, known);
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
