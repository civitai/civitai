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
import { accountSectionFor } from './account';
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

/**
 * The Civitai user a ticket is about: the router's match, else the account behind the requester's address.
 * Null when neither finds one; a failed address lookup is logged and reads as no match.
 */
export async function linkedCivitaiUserId(
  ticket: { requesterEmail?: string | null },
  routed: { civitaiUserId: number | null } | undefined
): Promise<number | null> {
  if (routed?.civitaiUserId != null) return routed.civitaiUserId;
  if (!ticket.requesterEmail) return null;
  try {
    return await resolveUserId(ticket.requesterEmail);
  } catch (e) {
    console.error('[tickets] user lookup failed', e);
    return null;
  }
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
  { canSeeEmail, canViewAccount }: { canSeeEmail: boolean; canViewAccount: boolean }
) {
  // Started with the ticket read: the two are independent, and a ticket refused below costs one wasted call.
  const conversation: Promise<TicketConversationResult> = isFreshdeskId(ticketId)
    ? getTicketConversation(ticketId).catch(() => CONVERSATION_UNAVAILABLE)
    : Promise.resolve(CONVERSATION_UNAVAILABLE);

  const read = await readTicketForView(view, ticketId);
  if (read.status === 'refused') return read;
  const { ticket, routed } = read;

  // The address is resolved here even without the grant, and never leaves the server without it.
  const civitaiUserId = await linkedCivitaiUserId(ticket, routed);
  const account = await accountSectionFor({
    view,
    cfFeature: ticket.cfFeature,
    routerTopic: routed?.topic ?? null,
    civitaiUserId,
    canView: canViewAccount,
  });

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
    // Present only for an account ticket whose viewer may open User Lookup; absent otherwise.
    ...(account ? { account } : {}),
    conversation: await conversation,
  };
}

export type TicketPayload = Extract<
  Awaited<ReturnType<typeof loadTicketPayload>>,
  { status: 'ok' }
>;
