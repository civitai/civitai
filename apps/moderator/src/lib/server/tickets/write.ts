import type { WriteResult } from '../freshdesk-write.service';
import type { EscalationFields } from '$lib/tickets/escalate';
import type { TicketView } from '$lib/tickets/routing';
import { statusLabel } from '$lib/tickets/statuses';

export type WriteDeps = {
  reply: (ticketId: string, bodyHtml: string) => Promise<WriteResult>;
  note: (ticketId: string, text: string) => Promise<WriteResult>;
  status: (ticketId: string, status: number) => Promise<WriteResult>;
  escalate: (ticketId: string, fields: EscalationFields) => Promise<WriteResult>;
  /** Best-effort record of who did it; never throws. */
  record: (moderatorId: number, ticketId: number, activity: string) => Promise<void>;
};

export type Moderator = { id: number; username?: string };

export type WriteOutcome =
  | { ok: true; statusChanged: boolean; movedTo?: TicketView; warning?: string }
  | { ok: false; notConfigured: boolean; message: string };

const NOT_CONFIGURED = 'FRESHDESK_WRITE_API_KEY is not configured — nothing was sent.';

/**
 * "NOT done" is said only when Freshdesk certainly refused the write. After a network error, a timeout
 * or a 5xx the write may have landed, and telling the moderator it did not invites a duplicate.
 */
const failure = (
  res: Exclude<WriteResult, { status: 'ok' }>,
  notDone: string,
  maybeDone: string
): WriteOutcome => {
  if (res.status === 'not_configured')
    return { ok: false, notConfigured: true, message: NOT_CONFIGURED };
  return {
    ok: false,
    notConfigured: false,
    message: res.certain
      ? `${notDone}: ${res.message}`
      : `${maybeDone} (${res.message}) — check the ticket in Freshdesk before retrying.`,
  };
};

const by = (m: Moderator) => `${m.username ?? 'unknown'} (user ${m.id}) from the moderator app.`;

/**
 * Reply and status writes, each followed by a private note naming the moderator: the reply goes out as the
 * key's shared seat, so the note is the only place the real sender is recorded.
 *
 * 🔴 ONCE THE REPLY OR STATUS CHANGE HAS LANDED, NOTHING AFTER IT MAY TURN THE RESULT INTO A FAILURE. A
 * failed note or status change on a sent reply is a `warning` on a success: reporting failure would
 * invite a resend, and the customer would be emailed twice.
 */
export function createTicketWriter(deps: WriteDeps) {
  const ticketNumber = (id: string) => Number(id);

  async function attribute(ticketId: string, lines: string[]): Promise<string | null> {
    const res = await deps.note(ticketId, lines.join('\n'));
    if (res.status === 'ok') return null;
    return res.status === 'not_configured' ? NOT_CONFIGURED : res.message;
  }

  return {
    async reply(
      ticketId: string,
      bodyHtml: string,
      statusAfter: number | null,
      moderator: Moderator
    ): Promise<WriteOutcome> {
      const sent = await deps.reply(ticketId, bodyHtml);
      if (sent.status !== 'ok')
        return failure(sent, 'The reply was NOT sent', 'The reply may or may not have been sent');
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketReply');

      const warnings: string[] = [];
      const lines = [`Sent by ${by(moderator)}`];
      let statusChanged = false;
      if (statusAfter !== null) {
        const res = await deps.status(ticketId, statusAfter);
        if (res.status === 'ok') {
          statusChanged = true;
          lines.push(`Status set to ${statusLabel(statusAfter)} by ${by(moderator)}`);
          await deps.record(moderator.id, ticketNumber(ticketId), 'ticketStatus');
        } else {
          warnings.push(
            `The reply was sent, but the status change failed: ${
              res.status === 'error' ? res.message : NOT_CONFIGURED
            }`
          );
        }
      }
      const noteError = await attribute(ticketId, lines);
      if (noteError)
        warnings.push(
          `The reply was sent, but the attribution note failed (${noteError}) — add "${lines.join(
            ' '
          )}" to the ticket by hand.`
        );
      return {
        ok: true,
        statusChanged,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      };
    },

    async setStatus(ticketId: string, status: number, moderator: Moderator): Promise<WriteOutcome> {
      const res = await deps.status(ticketId, status);
      if (res.status !== 'ok')
        return failure(
          res,
          'The status was NOT changed',
          'The status may or may not have been changed'
        );
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketStatus');
      const line = `Status set to ${statusLabel(status)} by ${by(moderator)}`;
      const noteError = await attribute(ticketId, [line]);
      return {
        ok: true,
        statusChanged: true,
        ...(noteError
          ? {
              warning: `The status was changed, but the attribution note failed (${noteError}) — add "${line}" to the ticket by hand.`,
            }
          : {}),
      };
    },

    /**
     * Hands a ticket to support: one PUT (tags, group, maybe status), then the activity row and a note
     * naming the moderator and why. Nothing is emailed to the customer.
     *
     * 🔴 ONCE THE PUT HAS LANDED the ticket has left the moderation view, so a failed note is a `warning`
     * on a success: a failure would send the moderator back to retry on a ticket that is already gone.
     */
    async escalate(
      ticketId: string,
      fields: EscalationFields,
      reason: string | null,
      moderator: Moderator
    ): Promise<WriteOutcome> {
      const res = await deps.escalate(ticketId, fields);
      if (res.status !== 'ok')
        return failure(
          res,
          'The ticket was NOT sent to support',
          'The ticket may or may not have been sent to support'
        );
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketEscalate');

      const lines = [
        `Sent to support by ${by(moderator)}`,
        ...(reason ? [`Reason: ${reason}`] : []),
      ];
      const noteError = await attribute(ticketId, lines);
      return {
        ok: true,
        statusChanged: true,
        movedTo: 'support',
        ...(noteError
          ? {
              warning: `The ticket was sent to support, but the attribution note failed (${noteError}) — add "${lines.join(
                ' '
              )}" to the ticket by hand.`,
            }
          : {}),
      };
    },
  };
}
