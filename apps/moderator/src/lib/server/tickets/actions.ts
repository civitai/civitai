import { fail } from '@sveltejs/kit';
import type { Actions } from '@sveltejs/kit';
import { requiresGrant } from '$lib/server/access';
import { addPrivateNote, replyToTicket, setTicketStatus } from '../freshdesk-write.service';
import { getTicketDetail, isFreshdeskId } from '../freshdesk.service';
import { recordModActivity } from '../mod-activity';
import { plainTextToHtml } from '$lib/tickets/reply-html';
import type { TicketView } from '$lib/tickets/routing';
import { isSettableStatus } from '$lib/tickets/statuses';
import { resolveTicketView } from './detail';
import { createTicketWriter, type WriteOutcome } from './write';

const MAX_REPLY_CHARS = 10_000;

const writer = createTicketWriter({
  reply: replyToTicket,
  // Notes are plain text here too, so a username can never inject markup into the ticket.
  note: (id, text) => addPrivateNote(id, plainTextToHtml(text) ?? ''),
  status: setTicketStatus,
  record: (userId, ticketId, activity) =>
    recordModActivity({ userId, entityType: 'ticket', entityId: ticketId, activity }),
});

/**
 * Re-reads the ticket right before a write: it must still belong to THIS view, whose page grant the
 * moderator holds, or a stale tab could answer a ticket from a view the role may not open.
 */
async function checkTicket(view: TicketView, ticketId: string) {
  if (!isFreshdeskId(ticketId)) return fail(404, { error: 'No such ticket.' });
  const res = await getTicketDetail(ticketId);
  if (res.status !== 'found')
    return fail(503, { error: `Could not check the ticket (${res.reason}) — nothing was sent.` });
  const { routesTo } = await resolveTicketView(ticketId, res.ticket);
  if (routesTo !== view)
    return fail(409, {
      error: `This ticket now belongs to the ${routesTo} view — nothing was sent. Go back to the list.`,
    });
  return null;
}

/** After a write: the success payload, noting if the change moved the ticket out of this view. */
async function settled(view: TicketView, ticketId: string, outcome: WriteOutcome) {
  if (!outcome.ok) return fail(outcome.notConfigured ? 503 : 502, { error: outcome.message });
  let moved: TicketView | null = null;
  if (outcome.statusChanged) {
    const res = await getTicketDetail(ticketId);
    if (res.status === 'found') {
      const { routesTo } = await resolveTicketView(ticketId, res.ticket);
      if (routesTo !== view) moved = routesTo;
    }
  }
  return { success: true as const, moved, warning: outcome.warning };
}

/**
 * `?/reply` and `?/status` for one view's ticket page. Both are behind `tickets.reply` on top of the
 * page grant, and both return `fail()` rather than throwing so the typed reply survives a refusal.
 */
export function ticketActions(view: TicketView): Actions {
  return {
    reply: requiresGrant('tickets.reply', async ({ request, params, locals }) => {
      const ticketId = params.ticketId ?? '';
      const form = await request.formData();
      const text = String(form.get('body') ?? '');
      const html = plainTextToHtml(text);
      if (!html) return fail(400, { error: 'Write a reply first.' });
      if (text.length > MAX_REPLY_CHARS)
        return fail(400, { error: `A reply is at most ${MAX_REPLY_CHARS} characters.` });
      const raw = String(form.get('statusAfter') ?? '');
      const statusAfter = raw === '' ? null : Number(raw);
      if (statusAfter !== null && !isSettableStatus(statusAfter))
        return fail(400, { error: 'That status cannot be set from here.' });

      const refused = await checkTicket(view, ticketId);
      if (refused) return refused;
      return settled(view, ticketId, await writer.reply(ticketId, html, statusAfter, locals.user));
    }),

    status: requiresGrant('tickets.reply', async ({ request, params, locals }) => {
      const ticketId = params.ticketId ?? '';
      const status = Number((await request.formData()).get('status'));
      if (!isSettableStatus(status))
        return fail(400, { error: 'That status cannot be set from here.' });

      const refused = await checkTicket(view, ticketId);
      if (refused) return refused;
      return settled(view, ticketId, await writer.setStatus(ticketId, status, locals.user));
    }),
  };
}
