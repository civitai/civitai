import { sql } from 'kysely';
import { songOrOwnCoverText } from '../audio-review-count';
import { dbRead } from '../db';
import { canAccess } from '../access';
import { resolveImageAppeal } from '../image-moderation.service';
import { parseResolutionReason } from '../image-queue';
import { withheldImageIds } from '../retracted-media';
import { IMAGE_APPEALS_PATH } from '$lib/tickets/appeals';
import { appealsPanelFor } from '$lib/tickets/appeals-panel';
import { linkedUserFor } from './account-actions';
import { createTicketAppealActions, type AppealWriteDeps } from './appeal-write';
import { ticketNote } from './ticket-note';

/** The ticket appeal actions' reads and writes; the help-desk ones are faked in tests. */
export const ticketAppealDeps: AppealWriteDeps = {
  linkedUser: linkedUserFor(
    appealsPanelFor,
    'This ticket no longer lists appeals — nothing was changed.'
  ),
  canAct: (user) => canAccess(user, IMAGE_APPEALS_PATH),
  withheld: async (user, imageId) => (await withheldImageIds(user, [imageId])).length > 0,
  appealOf: async (id) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['userId', 'status', 'entityType', 'entityId', 'entityRemovedAt', 'category'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  songImage: async (imageId) =>
    !!(await dbRead
      .selectFrom('Image as i')
      .select('i.id')
      .where('i.id', '=', imageId)
      .where(sql<boolean>`${sql.raw(songOrOwnCoverText('i'))}`)
      .executeTakeFirst()),
  needsReviewOf: async (imageId) =>
    (
      await dbRead
        .selectFrom('Image')
        .select('needsReview')
        .where('id', '=', imageId)
        .executeTakeFirst()
    )?.needsReview ?? null,
  parseReason: (form, verdict) => parseResolutionReason(form, verdict),
  resolve: ({ imageId, status, resolvedReason, internalNotes, userId, csamReview }) =>
    resolveImageAppeal({ imageId, status, resolvedReason, internalNotes, userId, csamReview }),
  note: ticketNote,
};

/** Image appeals only; removed-content, site-form and model-flag appeals are decided in their queues. */
export const ticketAppealActions = createTicketAppealActions(ticketAppealDeps);
