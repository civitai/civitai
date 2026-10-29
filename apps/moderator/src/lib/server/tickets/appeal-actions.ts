import { dbRead } from '../db';
import { canAccess } from '../access';
import { addPrivateNote } from '../freshdesk-write.service';
import { resolveImageAppeal } from '../image-moderation.service';
import { parseResolutionReason } from '../image-queue';
import { appealsPanelFor } from '$lib/tickets/panels';
import { plainTextToHtml } from '$lib/tickets/reply-html';
import { linkedUserFor } from './account-actions';
import { createTicketAppealActions } from './appeal-write';

/** Image appeals only; removed-content, site-form and model-flag appeals are decided in their queues. */
export const ticketAppealActions = createTicketAppealActions({
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists appeals — nothing was changed.'
  ),
  canAct: (user) => canAccess(user, '/images/appeals'),
  appealOf: async (id) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['userId', 'status', 'entityType', 'entityId', 'entityRemovedAt', 'category'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  parseReason: (form, verdict) => parseResolutionReason(form, verdict),
  resolve: ({ imageId, status, resolvedReason, internalNotes, userId }) =>
    resolveImageAppeal({ imageId, status, resolvedReason, internalNotes, userId }),
  note: (id, text) => addPrivateNote(id, plainTextToHtml(text) ?? ''),
});
