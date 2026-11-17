import { fail } from '@sveltejs/kit';
import type { Actions } from '@sveltejs/kit';
import { requiresGrant } from '$lib/server/access';
import { callModEndpoint } from '$lib/server/user-actions.service';
import {
  addPrivateNote,
  replyToTicket,
  setTicketStatus,
  updateTicket,
} from '../freshdesk-write.service';
import { getTicketDetail, isFreshdeskId } from '../freshdesk.service';
import { recordModActivity } from '../mod-activity';
import { PRIVACY_ACK_TEXT, escalationFields } from '$lib/tickets/escalate';
import { normalizeNewlines, plainTextToHtml } from '$lib/tickets/reply-html';
import type { TicketRoute, TicketView } from '$lib/tickets/routing';
import { isSettableStatus } from '$lib/tickets/statuses';
import { resolveTicketView } from './detail';
import { ticketSnapshot, toRecord } from './snapshot';
import { createTicketWriter, type FileBugResult, type WriteOutcome } from './write';

const MAX_REPLY_CHARS = 10_000;
const MAX_REASON_CHARS = 500;
// The main app takes 2,000 characters; the ticket-number line takes the rest.
const MAX_BUG_CHARS = 1_950;

/** Files the report through the main app as the moderator, so it gets the site's HQ filing too. */
async function fileBugReport(ticketId: string, message: string): Promise<FileBugResult> {
  const res = await callModEndpoint(
    'feedback/ticket-bug',
    { ticketId: Number(ticketId), message },
    'Filing the bug report'
  );
  if (!res.ok)
    return {
      status: 'error',
      message: res.error,
      // A 4xx is a refusal before the endpoint wrote anything; anything else may have landed.
      certain: !!res.requestNeverSent || (res.status !== undefined && res.status < 500),
    };
  const id = Number(res.body.id);
  if (!Number.isInteger(id) || id <= 0)
    return {
      status: 'error',
      message: 'the main app answered without a report id',
      certain: false,
    };
  return {
    status: 'ok',
    feedbackId: id,
    hqUrl: typeof res.body.hqUrl === 'string' ? res.body.hqUrl : null,
  };
}

const writer = createTicketWriter({
  reply: replyToTicket,
  // Notes are plain text here too, so a username can never inject markup into the ticket.
  note: (id, text) => addPrivateNote(id, plainTextToHtml(text) ?? ''),
  status: setTicketStatus,
  escalate: updateTicket,
  fileBug: fileBugReport,
  record: (userId, ticketId, activity) =>
    recordModActivity({ userId, entityType: 'ticket', entityId: ticketId, activity }),
});

/** The ticket a form acts on. The actions live on the list page, whose URL carries no ticket id. */
const ticketIdOf = (form: FormData) => String(form.get('ticketId') ?? '');

/**
 * Re-reads the ticket right before a write: it must still belong to THIS view, whose page grant the
 * moderator holds, or a stale tab could answer a ticket from a view the role may not open.
 */
async function readTicketForWrite(view: TicketView, ticketId: string) {
  if (!isFreshdeskId(ticketId)) return { refused: fail(404, { error: 'No such ticket.' }) };
  const res = await getTicketDetail(ticketId);
  if (res.status !== 'found')
    return {
      refused: fail(503, {
        error: `Could not check the ticket (${res.reason}) — nothing was sent.`,
      }),
    };
  const { routesTo } = await resolveTicketView(ticketId, res.ticket);
  if (routesTo !== view)
    return {
      refused: fail(409, {
        error: `This ticket now belongs to the ${routesTo} view — nothing was sent. Go back to the list.`,
      }),
    };
  return { ticket: res.ticket };
}

async function checkTicket(view: TicketView, ticketId: string) {
  return (await readTicketForWrite(view, ticketId)).refused ?? null;
}

/** Success payload, with `moved` set when the write took the ticket out of this view. Patches the snapshot from a fresh read so the list shows the write before the next delta. */
async function settled(view: TicketView, ticketId: string, outcome: WriteOutcome) {
  if (!outcome.ok) return fail(outcome.notConfigured ? 503 : 502, { error: outcome.message });
  let moved: TicketRoute | null = outcome.movedTo ?? null;
  const res = await getTicketDetail(ticketId);
  if (res.status === 'found') {
    await ticketSnapshot.patch(toRecord(res.ticket));
    if (!moved && outcome.statusChanged) {
      const { routesTo } = await resolveTicketView(ticketId, res.ticket);
      if (routesTo !== view) moved = routesTo;
    }
  }
  return {
    success: true as const,
    moved,
    statusChanged: outcome.statusChanged,
    warning: outcome.warning,
    feedbackId: outcome.feedbackId,
  };
}

const reasonOf = (form: FormData) => String(form.get('reason') ?? '').trim();
const reasonTooLong = () =>
  fail(400, { error: `A reason is at most ${MAX_REASON_CHARS} characters.` });

/** Actions return `fail()` rather than throwing so the typed text survives a refusal. */
export function ticketActions(view: TicketView): Actions {
  return {
    reply: requiresGrant('tickets.reply', async ({ request, locals }) => {
      const form = await request.formData();
      const ticketId = ticketIdOf(form);
      const text = normalizeNewlines(String(form.get('body') ?? ''));
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

    status: requiresGrant('tickets.reply', async ({ request, locals }) => {
      const form = await request.formData();
      const ticketId = ticketIdOf(form);
      const status = Number(form.get('status'));
      if (!isSettableStatus(status))
        return fail(400, { error: 'That status cannot be set from here.' });

      const refused = await checkTicket(view, ticketId);
      if (refused) return refused;
      return settled(view, ticketId, await writer.setStatus(ticketId, status, locals.user));
    }),

    ...(view === 'moderation'
      ? {
          escalate: requiresGrant('tickets.escalate', async ({ request, locals }) => {
            const form = await request.formData();
            const ticketId = ticketIdOf(form);
            const reason = String(form.get('reason') ?? '').trim();
            if (reason.length > MAX_REASON_CHARS)
              return fail(400, { error: `A reason is at most ${MAX_REASON_CHARS} characters.` });

            // The tags are read here, right before the PUT, because the PUT replaces them.
            const read = await readTicketForWrite(view, ticketId);
            if (read.refused) return read.refused;
            const { tags, status } = read.ticket;
            return settled(
              view,
              ticketId,
              await writer.escalate(
                ticketId,
                escalationFields(tags, status),
                reason || null,
                locals.user
              )
            );
          }),

          fileBug: requiresGrant('tickets.escalate', async ({ request, locals }) => {
            const form = await request.formData();
            const ticketId = ticketIdOf(form);
            const note = normalizeNewlines(reasonOf(form));
            if (!note) return fail(400, { error: 'Describe the bug first.' });
            if (note.length > MAX_BUG_CHARS)
              return fail(400, { error: `A bug report is at most ${MAX_BUG_CHARS} characters.` });

            const refused = await checkTicket(view, ticketId);
            if (refused) return refused;
            return settled(
              view,
              ticketId,
              await writer.fileBug(
                ticketId,
                `Freshdesk ticket #${ticketId}\n\n${note}`,
                locals.user
              )
            );
          }),

          privacy: requiresGrant('tickets.privacy', async ({ request, locals }) => {
            if (!locals.grants['tickets.escalate'] || !locals.grants['tickets.reply'])
              return fail(403, {
                error:
                  'Sending to Legal also needs the hand-off and reply permissions: it emails the requester.',
              });
            const form = await request.formData();
            const ticketId = ticketIdOf(form);
            const reason = reasonOf(form);
            if (reason.length > MAX_REASON_CHARS) return reasonTooLong();

            // The tags are read here, right before the PUT, because the PUT replaces them.
            const read = await readTicketForWrite(view, ticketId);
            if (read.refused) return read.refused;
            return settled(
              view,
              ticketId,
              await writer.privacy(
                ticketId,
                { tags: read.ticket.tags, createdAt: read.ticket.createdAt ?? null },
                reason || null,
                plainTextToHtml(PRIVACY_ACK_TEXT) ?? '',
                locals.user
              )
            );
          }),

          modLead: requiresGrant('tickets.escalate', async ({ request, locals, url }) => {
            const form = await request.formData();
            const ticketId = ticketIdOf(form);
            const reason = reasonOf(form);
            if (reason.length > MAX_REASON_CHARS) return reasonTooLong();

            const read = await readTicketForWrite(view, ticketId);
            if (read.refused) return read.refused;
            const ticketUrl = new URL(`/tickets/moderation?ticket=${ticketId}`, url.origin).href;
            return settled(
              view,
              ticketId,
              await writer.modLead(
                ticketId,
                read.ticket.tags,
                reason || null,
                ticketUrl,
                locals.user
              )
            );
          }),
        }
      : {}),
  };
}
