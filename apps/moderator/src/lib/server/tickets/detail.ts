import { error, redirect } from '@sveltejs/kit';
import {
  freshdeskTicketUrl,
  getTicketConversation,
  getTicketDetail,
  isFreshdeskId,
  type TicketConversationResult,
  type TicketDetail,
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

type Refused = { status: 'refused'; code: 404 | 503; message: string };

/**
 * One ticket read live from Freshdesk, accepted only when it routes to `view`. 🔴 The page grant is per
 * view, so a ticket served under the wrong view would show it to a role that may not open that view.
 * The snapshot takes the fresh copy; what it held before supplies the router answer.
 */
async function readTicketForView(
  view: TicketView,
  ticketId: string
): Promise<
  | {
      status: 'ok';
      ticket: TicketDetail;
      routed: Awaited<ReturnType<typeof resolveTicketView>>['routed'];
    }
  | Refused
> {
  if (!isFreshdeskId(ticketId)) return { status: 'refused', code: 404, message: 'No such ticket.' };
  const res = await getTicketDetail(ticketId);
  if (res.status !== 'found') return { status: 'refused', code: 503, message: res.reason };
  const { ticket } = res;
  const known = await ticketSnapshot.patch(toRecord(ticket));
  const { routesTo, routed } = await resolveTicketView(ticketId, ticket, known);
  if (routesTo !== view)
    return {
      status: 'refused',
      code: 404,
      message: `Ticket ${ticketId} is not a ${view} ticket; it belongs to the ${routesTo} view.`,
    };
  return { status: 'ok', ticket, routed };
}

/** Old `/tickets/<view>/<id>` links: the ticket opens in the triage list, once it is known to belong to the view. */
export async function openTicketInView(view: TicketView, ticketId: string): Promise<never> {
  const read = await readTicketForView(view, ticketId);
  if (read.status === 'refused') error(read.code, read.message);
  redirect(303, `/tickets/${view}?ticket=${read.ticket.id}`);
}

const CONVERSATION_UNAVAILABLE = {
  status: 'unavailable' as const,
  reason: 'Freshdesk could not be read.',
};

/**
 * What the open ticket's detail pane shows: the ticket with its description, and the conversation. Never
 * throws; a refusal carries the status the endpoint should answer with.
 */
export async function loadTicketPayload(
  view: TicketView,
  ticketId: string,
  { canSeeEmail }: { canSeeEmail: boolean }
) {
  // Started with the ticket read: the two are independent, and a ticket refused below costs one wasted call.
  const conversation: Promise<TicketConversationResult> = isFreshdeskId(ticketId)
    ? getTicketConversation(ticketId).catch(() => CONVERSATION_UNAVAILABLE)
    : Promise.resolve(CONVERSATION_UNAVAILABLE);

  const read = await readTicketForView(view, ticketId);
  if (read.status === 'refused') return read;
  const { ticket, routed } = read;

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

  return {
    status: 'ok' as const,
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
      tags: ticket.tags,
      requesterName: ticket.requesterName,
      ...(canSeeEmail ? { requesterEmail: ticket.requesterEmail } : {}),
      civitaiUserId,
      sentToSupport,
      sentBy,
    },
    conversation: await conversation,
  };
}

export type TicketPayload = Extract<
  Awaited<ReturnType<typeof loadTicketPayload>>,
  { status: 'ok' }
>;
