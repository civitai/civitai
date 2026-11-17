import { fail, type RequestEvent } from '@sveltejs/kit';
import { requiresGrant } from '../access';
import type { QueueInput, QueueResult } from '../personal-data-export.service';
import { addTicketNote, checkTicketTarget, type TicketActionDeps } from './panel-write';

export const ALREADY_QUEUED = 'An export for this account is already queued or building.';

export type ExportActionDeps = TicketActionDeps & {
  queue: (input: QueueInput) => Promise<QueueResult>;
};

/**
 * Queueing a personal-data export from a ticket's account panel. The account is the ticket's, never
 * the form's (`checkTicketTarget`). The build emails the moderator who queued it; nothing reaches
 * the account owner from here.
 */
export function createTicketExportActions(deps: ExportActionDeps) {
  return {
    accountQueueDataExport: requiresGrant(
      'user.personalDataExport.queue',
      async (event: RequestEvent) => {
        const ok = await checkTicketTarget(deps.linkedUser, event);
        if (ok.refused) return ok.refused;
        // The user asked when they opened the ticket: that date, from the help desk, starts the clock.
        const requestedAt = ok.ticketCreatedAt ? new Date(ok.ticketCreatedAt) : null;
        if (!requestedAt || Number.isNaN(requestedAt.getTime()))
          return fail(503, {
            error: "Could not read the ticket's date — nothing was queued. Try again.",
          });
        const result = await deps.queue({
          userId: ok.userId,
          requestedById: event.locals.user.id,
          ticketId: Number(ok.ticketId),
          requestedAt,
        });
        if (result.status === 'already-queued') return fail(409, { error: ALREADY_QUEUED });
        if (result.status === 'no-user') return fail(404, { error: 'No such account.' });
        if (result.status === 'error')
          return fail(500, { error: 'Could not queue the export; nothing was queued. Try again.' });
        return addTicketNote(
          deps.note,
          event,
          ok.ticketId,
          `Queued personal data export #${result.id} for user ${ok.userId}`
        );
      }
    ),
  };
}
