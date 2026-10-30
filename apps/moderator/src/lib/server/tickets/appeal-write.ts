import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm } from '../query';
import { classifyAppeal } from '$lib/tickets/appeals';
import {
  NOT_PERMITTED,
  addTicketNote,
  checkTicketTarget,
  type TicketActionDeps,
} from './panel-write';

export type AppealWriteRow = {
  userId: number;
  status: string;
  entityType: string;
  entityId: number;
  entityRemovedAt: Date | null;
  category: string | null;
};

export type AppealVerdict = 'Approved' | 'Rejected';

export type AppealWriteDeps = TicketActionDeps & {
  /** The `/images/appeals` page grant: the queue this ruling would otherwise be made in. */
  canAct: (user: App.Locals['user']) => boolean;
  appealOf: (id: number) => Promise<AppealWriteRow | null>;
  /** The image's `needsReview` flag, read from the database. */
  needsReviewOf: (imageId: number) => Promise<string | null>;
  /** The image queue's own reason rules, so a ruling from a ticket records what the queue would. */
  parseReason: (
    form: FormData,
    verdict: AppealVerdict
  ) => { resolvedReason: string; internalNotes: string | undefined } | string;
  /** `undefined` when no pending appeal was left to decide. */
  resolve: (input: {
    imageId: number;
    status: AppealVerdict;
    resolvedReason: string;
    internalNotes: string | undefined;
    userId: number;
  }) => Promise<{ id: number } | undefined>;
};

const ruling = z.object({ appealId: int4Id, status: z.enum(['Approved', 'Rejected']) });

export const DECIDED = 'That appeal has already been decided — nothing was changed.';

/**
 * The appeal row a ticket action was posted for, once it is confirmed to be a pending appeal of the
 * ticket's user. The caller still checks its kind, and decides with the row's ids, never the form's.
 */
export async function loadOwnedAppeal(
  appealOf: AppealWriteDeps['appealOf'],
  appealId: number,
  userId: number
) {
  const appeal = await appealOf(appealId);
  if (!appeal) return { refused: fail(404, { error: 'Appeal not found.' }) };
  if (appeal.userId !== userId)
    return {
      refused: fail(409, {
        error: 'That appeal belongs to another account — nothing was changed.',
      }),
    };
  if (appeal.status !== 'Pending') return { refused: fail(409, { error: DECIDED }) };
  return { appeal };
}

/**
 * 🔴 THE APPEAL RULED ON IS THE TICKET USER'S. `resolveImageAppeal` is keyed by image and closes
 * whichever pending appeal exists, checking nothing about who filed it, so the appeal row is read here:
 * it must be pending, a plain image appeal (not removed-content, not a site form, not a model's), still
 * flagged `appeal` on its image (what the queue lists), and filed by the user the ticket links to. The image decided is the row's, never the form's.
 */
export function createTicketAppealActions(deps: AppealWriteDeps) {
  return {
    appealResolveImage: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user)) return fail(403, { error: NOT_PERMITTED });
      const input = parseForm(ruling, await event.request.clone().formData());
      if (typeof input === 'string') return fail(400, { error: input });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;

      const owned = await loadOwnedAppeal(deps.appealOf, input.appealId, ok.userId);
      if (owned.refused) return owned.refused;
      const { appeal } = owned;
      if (classifyAppeal(appeal) !== 'image')
        return fail(409, {
          error:
            'That is not an image appeal; it is decided in its own queue — nothing was changed.',
        });
      if ((await deps.needsReviewOf(appeal.entityId)) !== 'appeal')
        return fail(409, {
          error: 'That image is no longer in the appeals queue — nothing was changed.',
        });

      const reason = deps.parseReason(ok.form, input.status);
      if (typeof reason === 'string') return fail(400, { error: reason });

      const closed = await deps.resolve({
        imageId: appeal.entityId,
        status: input.status,
        ...reason,
        userId: event.locals.user.id,
      });
      if (!closed) return fail(409, { error: DECIDED });
      // `resolve` closes whichever appeal is pending on the image, which may not be the one posted.
      // The change is made either way, so it is reported and noted, never failed.
      const swapped = closed.id !== input.appealId;
      const res = await addTicketNote(
        deps.note,
        event,
        ok.ticketId,
        `${input.status} appeal #${closed.id} (image ${appeal.entityId}) of user ${ok.userId}`
      );
      if (!swapped) return res;
      const warning = `Appeal #${closed.id} on that image was decided instead of #${input.appealId}.`;
      return {
        success: true as const,
        warning: 'warning' in res ? `${warning} ${res.warning}` : warning,
      };
    },
  };
}
