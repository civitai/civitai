import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm } from '../query';
import { ReportStatus } from '$lib/rating-review';
import { RATINGS_PATH } from '$lib/tickets/rating-disputes';
import { DECIDED } from './appeal-write';
import {
  NOT_PERMITTED,
  addTicketNote,
  checkTicketTarget,
  type TicketActionDeps,
} from './panel-write';

export type RatingWriteDeps = TicketActionDeps & {
  /** The viewer's grant on the rating disputes page. */
  canAct: (user: App.Locals['user'], path: string) => boolean;
  reviewOf: (id: number) => Promise<{
    id: number;
    userId: number;
    status: string;
    entityType: string;
    entityId: number;
  } | null>;
  /** The Rating Disputes queue's own ruling, so a ruling from a ticket records what the queue would. */
  resolve: (input: {
    reviewId: number;
    appliedLevel: number;
    modComment?: string;
    userId: number;
  }) => Promise<{ ok: true; status: string } | { ok: false; error: string }>;
};

const ruling = z.object({
  reviewId: int4Id,
  appliedLevel: z.coerce.number().int().positive(),
  modComment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

/**
 * 🔴 THE DISPUTE RULED ON IS THE TICKET USER'S. The main app's resolver is keyed by review id and checks
 * nothing about who filed it, so the row is read first: filed by the ticket's linked user, and still
 * pending. The review ruled on is the row's id; the level is checked against that review's own allowed
 * levels by the resolver, under the Rating Disputes queue's grant.
 */
export function createTicketRatingActions(deps: RatingWriteDeps) {
  return {
    ratingDisputeResolve: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user, RATINGS_PATH)) return fail(403, { error: NOT_PERMITTED });
      const input = parseForm(ruling, await event.request.clone().formData());
      if (typeof input === 'string') return fail(400, { error: input });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;

      const review = await deps.reviewOf(input.reviewId);
      if (!review) return fail(404, { error: 'Dispute not found.' });
      if (review.userId !== ok.userId)
        return fail(409, {
          error: 'That dispute belongs to another account — nothing was changed.',
        });
      if (review.status !== ReportStatus.Pending) return fail(409, { error: DECIDED });

      const result = await deps.resolve({
        reviewId: review.id,
        appliedLevel: input.appliedLevel,
        modComment: input.modComment,
        userId: event.locals.user.id,
      });
      if (!result.ok) return fail(409, { error: result.error });

      const verdict = result.status === ReportStatus.Actioned ? 'Approved' : 'Rejected';
      const res = await addTicketNote(
        deps.note,
        event,
        ok.ticketId,
        `${verdict} rating dispute #${review.id} (${review.entityType} ${review.entityId}, level ${input.appliedLevel}) of user ${ok.userId}`
      );
      return { ...res, status: result.status };
    },
  };
}
