import { dbRead } from '../db';
import { canAccess } from '../access';
import { ruleFlagAppeal } from '../minor-flag-appeal-ruling';
import { appealsPanelFor } from '$lib/tickets/appeals-panel';
import { linkedUserFor } from './account-actions';
import { createTicketFlagAppealActions } from './appeal-flag-write';
import { ticketNote } from './ticket-note';

/** Model minor/real-person flag appeals, ruled under the model flag appeals queue's grant. */
export const ticketFlagAppealActions = createTicketFlagAppealActions({
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists appeals — nothing was changed.'
  ),
  canAct: (user, path) => canAccess(user, path),
  appealOf: async (id) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['userId', 'status', 'entityType', 'entityId', 'entityRemovedAt', 'category'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  ruleAppeal: ruleFlagAppeal,
  note: ticketNote,
});
