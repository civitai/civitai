import { dbRead } from '../db';
import { canAccess } from '../access';
import { parseRemovedAppealRuling, resolveRemovedAppeal } from '../removed-appeals.service';
import { resolveSiteAppeal } from '../site-appeals.service';
import { appealsPanelFor } from '$lib/tickets/appeals-panel';
import { linkedUser, linkedUserFor } from './account-actions';
import { createTicketQueueAppealActions } from './appeal-queue-write';
import { ticketNote } from './ticket-note';

/** Removed-content and site-form appeals, ruled under their own queue's grant; Account appeals from the Account card. */
export const ticketQueueAppealActions = createTicketQueueAppealActions({
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists appeals — nothing was changed.'
  ),
  accountLinkedUser: linkedUser,
  canAct: (user, path) => canAccess(user, path),
  appealOf: async (id) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['userId', 'status', 'entityType', 'entityId', 'entityRemovedAt', 'category'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  parseRemoved: parseRemovedAppealRuling,
  resolveRemoved: resolveRemovedAppeal,
  resolveSite: resolveSiteAppeal,
  note: ticketNote,
});
