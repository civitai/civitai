import type { WriteResult } from '../freshdesk-write.service';
import { statusLabel } from '$lib/tickets/statuses';

export type WriteDeps = {
  reply: (ticketId: string, bodyHtml: string) => Promise<WriteResult>;
  note: (ticketId: string, text: string) => Promise<WriteResult>;
  status: (ticketId: string, status: number) => Promise<WriteResult>;
  /** Best-effort record of who did it; never throws. */
  record: (moderatorId: number, ticketId: number, activity: string) => Promise<void>;
};

export type Moderator = { id: number; username?: string };

export type WriteOutcome =
  | { ok: true; statusChanged: boolean; warning?: string }
  | { ok: false; notConfigured: boolean; message: string };

const NOT_CONFIGURED = 'FRESHDESK_WRITE_API_KEY is not configured — nothing was sent.';

const failure = (res: Exclude<WriteResult, { status: 'ok' }>, what: string): WriteOutcome =>
  res.status === 'not_configured'
    ? { ok: false, notConfigured: true, message: NOT_CONFIGURED }
    : { ok: false, notConfigured: false, message: `${what}: ${res.message}` };

const by = (m: Moderator) => `${m.username ?? 'unknown'} (user ${m.id}) from the moderator app.`;
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
      if (sent.status !== 'ok') return failure(sent, 'The reply was NOT sent');
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
      if (res.status !== 'ok') return failure(res, 'The status was NOT changed');
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
  };
}
