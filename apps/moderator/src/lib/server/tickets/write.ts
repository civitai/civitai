import type { WriteResult } from '../freshdesk-write.service';
import { modLeadFields, privacyFields, type EscalationFields } from '$lib/tickets/escalate';
import { PRIVACY_REQUEST_TAG, hasTag, type TicketRoute } from '$lib/tickets/routing';
import { statusLabel } from '$lib/tickets/statuses';

export type WriteDeps = {
  reply: (ticketId: string, bodyHtml: string) => Promise<WriteResult>;
  note: (ticketId: string, text: string) => Promise<WriteResult>;
  status: (ticketId: string, status: number) => Promise<WriteResult>;
  escalate: (ticketId: string, fields: EscalationFields) => Promise<WriteResult>;
  /** Files a site bug report as the moderator, linked to the ticket. */
  fileBug: (ticketId: string, message: string) => Promise<FileBugResult>;
  /** Best-effort record of who did it; never throws. */
  record: (moderatorId: number, ticketId: number, activity: string) => Promise<void>;
};

export type Moderator = { id: number; username?: string };

export type FileBugResult =
  | { status: 'ok'; feedbackId: number; hqUrl: string | null }
  | { status: 'error'; message: string; certain: boolean };

export type WriteOutcome =
  | {
      ok: true;
      statusChanged: boolean;
      movedTo?: TicketRoute;
      warning?: string;
      feedbackId?: number;
    }
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
 * Reply and status writes, each followed by a private note naming the moderator: Freshdesk records only
 * the key's agent as the sender, so the note is the only place the real sender is recorded.
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

    /** Files a bug report for the dev queue and leaves the ticket as it is; the note links the two. */
    async fileBug(ticketId: string, note: string, moderator: Moderator): Promise<WriteOutcome> {
      const filed = await deps.fileBug(ticketId, note);
      if (filed.status !== 'ok')
        return {
          ok: false,
          notConfigured: false,
          message: filed.certain
            ? `The bug report was NOT filed: ${filed.message}`
            : `The bug report may or may not have been filed (${filed.message}) — check the feedback queue before retrying.`,
        };
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketFileBug');
      const lines = [
        `Filed as bug report #${filed.feedbackId} by ${by(moderator)}`,
        ...(filed.hqUrl ? [`HQ: ${filed.hqUrl}`] : []),
      ];
      const noteError = await attribute(ticketId, lines);
      const warnings: string[] = [];
      // No hqUrl: the HQ filing was capped or down.
      if (!filed.hqUrl)
        warnings.push(
          `Bug report #${filed.feedbackId} was saved, but it did NOT reach the dev queue in HQ — ask a developer to file it there.`
        );
      if (noteError)
        warnings.push(
          `Bug report #${
            filed.feedbackId
          } was filed, but the ticket note failed (${noteError}) — add "${lines.join(
            ' '
          )}" to the ticket by hand.`
        );
      return {
        ok: true,
        statusChanged: false,
        feedbackId: filed.feedbackId,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      };
    },

    /**
     * Hands a ticket to Legal: a note, the PUT (tag + Waiting on Dev), then Legal's acknowledgment to the
     * requester, sent only when the ticket did not already carry the tag, so a second hand-off only
     * re-routes.
     *
     * 🔴 THE NOTE GOES FIRST. A Freshdesk rule sets any ticket at Waiting on Dev to Pending when a private
     * note is added to it; written after the PUT, our own note would move the ticket off Legal's status.
     *
     * 🔴 ONCE THE PUT HAS LANDED the ticket is Legal's, so a failed acknowledgment is a `warning` on a
     * success that says whether it went, never a failure: a failure invites a second click.
     */
    async privacy(
      ticketId: string,
      ticket: { tags: readonly string[]; createdAt: string | null },
      reason: string | null,
      ackHtml: string,
      moderator: Moderator
    ): Promise<WriteOutcome> {
      const alreadyTagged = hasTag(ticket.tags, PRIVACY_REQUEST_TAG);
      const lines = [
        `Sent to Legal (privacy request) by ${by(moderator)}`,
        `Received: ${ticket.createdAt ?? 'unknown'}`,
        alreadyTagged
          ? 'Already tagged as a privacy request: re-routed only, no acknowledgment sent.'
          : "Legal's acknowledgment goes to the requester next.",
        ...(reason ? [`Reason: ${reason}`] : []),
      ];
      const noteError = await attribute(ticketId, lines);

      const res = await deps.escalate(ticketId, privacyFields(ticket.tags));
      if (res.status !== 'ok') {
        await attribute(ticketId, [
          res.status === 'error' && !res.certain
            ? 'The hand-off to Legal above may or may not have gone through; check the tag and status.'
            : 'The hand-off to Legal above did NOT go through.',
        ]);
        return failure(
          res,
          'The ticket was NOT sent to Legal',
          `The ticket may or may not have been sent to Legal. If it now carries the ${PRIVACY_REQUEST_TAG} tag, Legal has it and the acknowledgment still needs sending by hand`
        );
      }
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketPrivacy');

      const warnings: string[] = [];
      if (noteError)
        warnings.push(
          `The ticket was sent to Legal, but the note failed (${noteError}) — add "${lines.join(
            ' '
          )}" to the ticket by hand.`
        );
      if (!alreadyTagged) {
        const sent = await deps.reply(ticketId, ackHtml);
        if (sent.status !== 'ok')
          warnings.push(
            sent.status === 'error' && !sent.certain
              ? `The ticket was sent to Legal, but the acknowledgment may or may not have been sent (${sent.message}) — check the ticket in Freshdesk before sending it by hand.`
              : `The ticket was sent to Legal, but the acknowledgment was NOT sent (${
                  sent.status === 'error' ? sent.message : NOT_CONFIGURED
                }) — send Legal's acknowledgment by hand.`
          );
      }
      return {
        ok: true,
        statusChanged: true,
        movedTo: 'legal',
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      };
    },

    /**
     * Hands a ticket to the mod lead. The note carries the moderator-app link so the ticket stands on its
     * own. Nothing is emailed.
     */
    async modLead(
      ticketId: string,
      tags: readonly string[],
      reason: string | null,
      ticketUrl: string,
      moderator: Moderator
    ): Promise<WriteOutcome> {
      const res = await deps.escalate(ticketId, modLeadFields(tags));
      if (res.status !== 'ok')
        return failure(
          res,
          'The ticket was NOT sent to the mod lead',
          'The ticket may or may not have been sent to the mod lead'
        );
      await deps.record(moderator.id, ticketNumber(ticketId), 'ticketModLead');
      const lines = [
        `Sent to the mod lead by ${by(moderator)}`,
        `Moderator app: ${ticketUrl}`,
        ...(reason ? [`Reason: ${reason}`] : []),
      ];
      const noteError = await attribute(ticketId, lines);
      return {
        ok: true,
        statusChanged: true,
        ...(noteError
          ? {
              warning: `The ticket was sent to the mod lead, but the note failed (${noteError}) — add "${lines.join(
                ' '
              )}" to the ticket by hand.`,
            }
          : {}),
      };
    },
  };
}
