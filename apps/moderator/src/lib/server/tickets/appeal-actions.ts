import { dbRead } from '../db';
import { canAccess } from '../access';
import { resolveImageAppeal } from '../image-moderation.service';
import { parseResolutionReason } from '../image-queue';
import { IMAGE_APPEALS_PATH } from '$lib/tickets/appeals';
import { appealsPanelFor } from '$lib/tickets/appeals-panel';
import { linkedUserFor } from './account-actions';
import { createTicketAppealActions } from './appeal-write';
import { ticketNote } from './ticket-note';

/** Image appeals only; removed-content, site-form and model-flag appeals are decided in their queues. */
export const ticketAppealActions = createTicketAppealActions({
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists appeals — nothing was changed.'
  ),
  canAct: (user) => canAccess(user, IMAGE_APPEALS_PATH),
  appealOf: async (id) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['userId', 'status', 'entityType', 'entityId', 'entityRemovedAt', 'category'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  needsReviewOf: async (imageId) =>
    (
      await dbRead
        .selectFrom('Image')
        .select('needsReview')
        .where('id', '=', imageId)
        .executeTakeFirst()
    )?.needsReview ?? null,
  parseReason: (form, verdict) => parseResolutionReason(form, verdict),
  resolve: ({ imageId, status, resolvedReason, internalNotes, userId }) =>
    resolveImageAppeal({ imageId, status, resolvedReason, internalNotes, userId }),
  note: ticketNote,
});
