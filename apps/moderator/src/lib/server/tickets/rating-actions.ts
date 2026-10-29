import { dbRead } from '../db';
import { canAccess } from '../access';
import { resolveRatingReviewAction } from '../rating-review-actions';
import { appealsPanelFor } from '$lib/tickets/appeals-panel';
import { linkedUserFor } from './account-actions';
import { ticketNote } from './ticket-note';
import { createTicketRatingActions } from './rating-write';

/** Rating disputes, ruled under the Rating Disputes queue's grant. */
export const ticketRatingActions = createTicketRatingActions({
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists rating disputes — nothing was changed.'
  ),
  canAct: (user, path) => canAccess(user, path),
  reviewOf: async (id) =>
    (await dbRead
      .selectFrom('RatingReview')
      .select(['id', 'userId', 'status', 'entityType', 'entityId'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  resolve: resolveRatingReviewAction,
  note: ticketNote,
});
